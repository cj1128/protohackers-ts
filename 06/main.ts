import { createServer, Socket } from "node:net"
import { SlidingBufferReader } from "../utils"
import assert from "assert"
import _ from "lodash"
import { TokenClass } from "typescript"

const MessageEncoder = {
  error(str: string): Buffer {
    const prefix = Buffer.from([0x10])
    return Buffer.concat([prefix, MessageEncoder.str(str)])
  },
  heartbeat() {
    return Buffer.from([0x41])
  },
  ticket(ticket: TicketExt) {
    const prefix = Buffer.from([0x21])
    return Buffer.concat([
      prefix,
      MessageEncoder.str(ticket.plate),
      MessageEncoder.u16(ticket.road),
      MessageEncoder.u16(ticket.mile1),
      MessageEncoder.u32(ticket.timestamp1),
      MessageEncoder.u16(ticket.mile2),
      MessageEncoder.u32(ticket.timestamp2),
      MessageEncoder.u16(ticket.speed),
    ])
  },
  //
  // helpers
  //
  str(str: string): Buffer {
    assert.ok(str.length <= 255)
    const buf = MessageEncoder.u8(str.length)
    return Buffer.concat([buf, Buffer.from(str)])
  },

  u8(num: number): Uint8Array {
    const buf = Buffer.alloc(1)
    buf.writeUInt8(num)
    return buf
  },
  u16(num: number): Buffer {
    const buf = Buffer.alloc(2)
    buf.writeUInt16BE(num)
    return buf
  },
  u32(num: number): Buffer {
    const buf = Buffer.alloc(4)
    buf.writeUint32BE(num)
    return buf
  },
}

export async function* readMessage(
  socket: Socket
): AsyncGenerator<InMessage | null> {
  const reader = new SlidingBufferReader()

  for await (const chunk of socket) {
    reader.append(chunk)

    inner: while (true) {
      const type = reader.peek(1)
      if (type == null) break

      switch (type[0]) {
        case InMessageType.IAmCamera:
          {
            if (reader.available < 7) {
              break inner
            }

            reader.read(1) // discard 1 byte
            const road = reader.readU16BE()!
            const mile = reader.readU16BE()!
            const limit = reader.readU16BE()!
            assert.ok(road != null && mile != null && limit != null)

            yield {
              type: InMessageType.IAmCamera,
              road,
              mile,
              limit,
            }
          }
          break
        case InMessageType.IAmDispatcher:
          {
            const buf = reader.peek(2)
            if (buf == null) {
              break inner
            }
            const numroads = buf[1]!
            if (reader.available < numroads * 2 + 2) {
              break inner
            }

            reader.read(2) // discard 2 bytes
            const roads: number[] = []

            for (let i = 0; i < numroads; i++) {
              const road = reader.readU16BE()
              assert.ok(road != null)
              roads.push(road)
            }

            yield { type: InMessageType.IAmDispatcher, numroads, roads }
          }
          break
        case InMessageType.Plate:
          {
            let buf = reader.peek(2)
            if (buf == null) {
              break inner
            }
            const len = buf[1]!
            buf = reader.peek(2 + len + 4)
            if (buf == null) {
              break inner
            }
            reader.read(2) // discard 2 bytes
            const plate = reader.read(len)!.toString()
            const timestamp = reader.readU32BE()
            assert.ok(plate != null && timestamp != null)
            yield { type: InMessageType.Plate, plate, timestamp }
          }
          break
        case InMessageType.WantHeartbeat:
          {
            const buf = reader.peek(5)
            if (buf == null) {
              break inner
            }
            reader.read(1)
            const interval = reader.readU32BE()
            assert.ok(interval != null)
            yield { type: InMessageType.WantHeartbeat, interval }
          }
          break
        // error
        default:
          yield null
      }
    }
  }
}

type u8 = number
type u16 = number
type u32 = number

type InMessage = Plate | WantHeartbeat | IAmCamera | IAmDispatcher
enum InMessageType {
  Plate = 0x20,
  WantHeartbeat = 0x40,
  IAmCamera = 0x80,
  IAmDispatcher = 0x81,
}
type Plate = {
  type: InMessageType.Plate
  plate: string
  timestamp: u32
}
type WantHeartbeat = {
  type: InMessageType.WantHeartbeat
  interval: u32
}
type IAmCamera = {
  type: InMessageType.IAmCamera
  road: u16
  mile: u16
  limit: u16
}
type IAmDispatcher = {
  type: InMessageType.IAmDispatcher
  numroads: u8
  roads: u16[]
}

type OutMessage = Error | Ticket | Heartbeat
type Error = {
  type: 0x10
  msg: string
}
type Ticket = {
  type: 0x21
  plate: string
  road: u16
  mile1: u16
  timestamp1: u32
  mile2: u16
  timestamp2: u32
  speed: u16
}
type Heartbeat = {
  type: 0x41
}

type ClientInfo = {
  clientId: number
  type: null | IAmCamera | IAmDispatcher
  heartbeat: null | number // in ms
  heartbeatTimer: null | NodeJS.Timeout
  socket: Socket
}

type SpeedRecord = {
  mile: u16
  timestamp: u32
  limit: u16
}
interface TicketExt extends Ticket {
  id: number
  startDay: number
  endDay: number
}

function getDay(timestamp: number): number {
  return Math.floor(timestamp / 86400)
}

class DataCenter {
  // key: plate, road
  private records: Map<string, Map<u16, SpeedRecord[]>>
  // key: plate, day
  private carTicket: Map<String, Map<number, boolean>>
  // key: road, ticketId
  private storedTickets: Map<u16, Map<number, TicketExt>>
  private ticketIdSeed = 0
  private ticketIds = new Map<string, number>()

  constructor() {
    this.records = new Map<string, Map<u16, SpeedRecord[]>>()
    this.carTicket = new Map()
    this.storedTickets = new Map()
  }

  genTicketId(
    plate: string,
    road: number,
    mile1: number,
    timestamp1: number,
    mile2: number,
    timestamp2: number
  ) {
    const key = [plate, road, mile1, timestamp1, mile2, timestamp2].join(".")
    let id = this.ticketIds.get(key)
    if (id == null) {
      id = this.ticketIdSeed++
      this.ticketIds.set(key, id)
    }
    return id
  }

  addSpeedRecord(camera: IAmCamera, plate: Plate) {
    let m1 = this.records.get(plate.plate)
    if (m1 == null) {
      m1 = new Map()
      this.records.set(plate.plate, m1)
    }

    let records = m1.get(camera.road)
    if (records == null) {
      records = []
      m1.set(camera.road, records)
    }

    records.push({
      mile: camera.mile,
      timestamp: plate.timestamp,
      limit: camera.limit,
    })
  }

  calcTickets(plate: string): TicketExt[] {
    const result: TicketExt[] = []
    const r = this.records.get(plate)
    if (r) {
      r.forEach((arr, road) => {
        const sorted = _.orderBy(arr, ["timestamp"], ["asc"])

        for (let i = 1; i < sorted.length; i++) {
          const mile1 = sorted[i - 1]!.mile
          const timestamp1 = sorted[i - 1]!.timestamp
          const mile2 = sorted[i]!.mile
          const timestamp2 = sorted[i]!.timestamp
          const limit = sorted[i]!.limit

          const seconds = timestamp2 - timestamp1
          assert.ok(seconds !== 0, "duration should > 0")

          // miles per hour
          const speed = (Math.abs(mile2 - mile1) / seconds) * 3600

          // we have a ticket
          if (speed >= limit + 0.5) {
            // 'mile1' must be the smaller timestamp
            result.push({
              type: 0x21,
              id: this.genTicketId(
                plate,
                road,
                mile1,
                timestamp1,
                mile2,
                timestamp2
              ),
              plate,
              road,
              mile1,
              timestamp1,
              mile2,
              timestamp2,
              speed: (speed * 100) >> 0,
              startDay: getDay(timestamp1),
              endDay: getDay(timestamp2),
            })
          }
        }
      })
    }

    return result
  }

  hasTicket(plate: string, day: number): boolean {
    const m = this.carTicket.get(plate)
    return !!m?.get(day)
  }

  hasTicketInRange(
    plate: string,
    startDay: number,
    endDay: number
  ): number | null {
    for (let day = startDay; day <= endDay; day++) {
      // 1 ticket per car per day
      if (this.hasTicket(plate, day)) {
        return day
      }
    }
    return null
  }

  markDispatched(ticket: TicketExt) {
    let m = this.carTicket.get(ticket.plate)
    if (m == null) {
      m = new Map()
      this.carTicket.set(ticket.plate, m)
    }
    for (let day = ticket.startDay; day <= ticket.endDay; day++) {
      m.set(day, true)
    }

    // remove stored ticket
    {
      const m = this.storedTickets.get(ticket.road)
      if (m) {
        m.delete(ticket.id)
      }
    }
  }

  storeTicket(ticket: TicketExt) {
    let m = this.storedTickets.get(ticket.road)
    if (m == null) {
      m = new Map()
      this.storedTickets.set(ticket.road, m)
    }
    m.set(ticket.id, ticket)
  }
  getStoredTickets(road: number): TicketExt[] {
    const m = this.storedTickets.get(road)
    if (m) {
      return [...m.values()]
    }
    return []
  }
}

const dc = new DataCenter()

// key: road, value: socket[]
const dispatchers = new Map<u16, Set<ClientInfo>>()

let clientIdSeed = 0
const server = createServer(async (client) => {
  const clientInfo: ClientInfo = {
    clientId: clientIdSeed++,
    type: null,
    heartbeat: null,
    heartbeatTimer: null,
    socket: client,
  }

  function log(...args: any[]) {
    console.log(`[${clientInfo.clientId}]`, ...args)
  }

  function startDispatch(ticket: TicketExt, dispatcher: ClientInfo) {
    log("start to dispatch ticket", {
      ticketId: ticket.id,
      dispatcherId: dispatcher.clientId,
    })

    // 1 ticket per car per day
    for (let day = ticket.startDay; day <= ticket.endDay; day++) {
      if (dc.hasTicket(ticket.plate, day)) {
        log(`plate already had ticket on day ${day}`)
        return
      }
    }

    dispatcher.socket.write(MessageEncoder.ticket(ticket))
    dc.markDispatched(ticket)

    log("ticket dispatched")
  }

  log("client connected")

  function onError(msg: string) {
    log("error occurred", { msg })
    client.write(MessageEncoder.error(msg))
    client.end()
  }

  client.on("end", () => {
    log("client disconnected")
    if (clientInfo.type?.type === InMessageType.IAmDispatcher) {
      clientInfo.type.roads.forEach((road) => {
        const s = dispatchers.get(road)
        if (s) {
          s.delete(clientInfo)
        }
      })
    }
    if (clientInfo.heartbeatTimer != null) {
      clearInterval(clientInfo.heartbeatTimer)
    }
  })

  for await (const msg of readMessage(client)) {
    log("Msg received", { msg, type: msg && InMessageType[msg.type!] })

    // error
    if (msg == null) {
      onError("invalid msg")
      return
    }

    switch (msg.type) {
      case InMessageType.IAmDispatcher:
      case InMessageType.IAmCamera:
        {
          // error
          if (clientInfo.type != null) {
            onError("client has already been identified")
            return
          }

          clientInfo.type = msg

          if (msg.type === InMessageType.IAmDispatcher) {
            msg.roads.forEach((road) => {
              // add this dispatcher
              {
                let s = dispatchers.get(road)
                if (s == null) {
                  s = new Set()
                  dispatchers.set(road, s)
                }
                s.add(clientInfo)
              }

              // check stored ticket
              const storedTickets = dc.getStoredTickets(road)
              if (storedTickets.length > 0) {
                storedTickets.forEach((ticket) => {
                  log("handle stored ticket", ticket)
                  startDispatch(ticket, clientInfo)
                })
              }
            })
          }
        }
        break
      case InMessageType.WantHeartbeat:
        {
          if (clientInfo.heartbeat != null) {
            onError("multiple WantHeartbeat messages received")
            return
          }

          clientInfo.heartbeat = msg.interval * 100
          if (clientInfo.heartbeat > 0) {
            clientInfo.heartbeatTimer = setInterval(() => {
              client.write(MessageEncoder.heartbeat())
            }, clientInfo.heartbeat)
          }
        }
        break
      case InMessageType.Plate:
        {
          // error
          if (clientInfo.type?.type !== InMessageType.IAmCamera) {
            onError("client is not a Camera")
            return
          }

          dc.addSpeedRecord(clientInfo.type, msg)

          const tickets = dc.calcTickets(msg.plate)
          log("tickets calculated", { plate: msg.plate, tickets })

          tickets.forEach((ticket) => {
            log("handle ticket", ticket.id)

            // if we have the dispatcher
            const ds = dispatchers.get(ticket.road)
            if (ds && ds.size >= 1) {
              const c = [...ds][0]!
              startDispatch(ticket, c)
            } else {
              // we store the ticket
              log("no dispatcher found, store ticket")
              dc.storeTicket(ticket)
            }
          })
        }
        break
      default:
        throw new Error("unreachable")
    }
  }
})

const PORT = 8888

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`)
})
