import { createServer, Socket, createConnection } from "node:net"
import Mutex from "p-mutex"
import _ from "lodash"
import {
  MessageEncoder,
  MessageType,
  PolicyAction,
  readMessage,
  type MessageSiteVisit,
} from "./msg"
import fs from "node:fs"

const servers = new Map<number, Server>()

// key: site, species
const sitePopulations = new Map<number, Map<string, number>>()

// key: site, species
const targetPopulations = new Map<
  number,
  Map<string, { min: number; max: number }>
>()

// key: site, species
const policyMap = new Map<
  number,
  Map<string, { action: PolicyAction; policy: number }>
>()

process.on("SIGINT", () => {
  console.log("write data for debugging")

  function stringify(data: any) {
    return JSON.stringify(data, null, 2)
  }

  {
    const obj: any = {}
    sitePopulations.forEach((v, k) => {
      obj[k] = Object.fromEntries(v)
    })
    fs.writeFileSync("./tmp/site-populations.json", stringify(obj))
  }

  {
    const obj: any = {}
    targetPopulations.forEach((v, k) => {
      obj[k] = Object.fromEntries(v)
    })

    fs.writeFileSync("./tmp/target-populations.json", stringify(obj))
  }

  {
    const obj: any = {}
    policyMap.forEach((v, k) => {
      obj[k] = Object.fromEntries(v)
    })
    fs.writeFileSync("./tmp/policy-map.json", stringify(obj))
  }

  process.exit(0)
})

class Server {
  private socket: Socket
  private site: number
  private readyResolver: any
  private iterator: any
  private mutexes = new Map()

  constructor(site: number) {
    this.site = site

    this.socket = createConnection(
      {
        host: "pestcontrol.protohackers.com",
        port: 20547,
      },
      async () => {
        const server = this.socket
        const site = this.site
        const iterator = this.iterator
        const log = this.log.bind(this)
        const onError = this.onError.bind(this)

        log("server connected")

        // send hello
        {
          server.write(MessageEncoder.hello())
          let v = await iterator.next()
          if (v.done) {
            onError("socket unexpectedly closed")
            return
          }
          const msg = v.value
          log("msg received", { msg })
          if (msg.type !== MessageType.hello) {
            onError("first message must be Hello")
            return
          }

          if (msg.protocol !== "pestcontrol" || msg.version !== 1) {
            onError("invalid protocol or version")
            return
          }
        }

        // dial authority
        if (targetPopulations.get(site) == null) {
          server.write(MessageEncoder.dialAuthority(site))
          let v = await iterator.next()
          if (v.done) {
            onError("socket unexpectedly closed")
            return
          }
          const msg = v.value
          log("msg received", { msg })
          if (msg.type !== MessageType.targetPopulations) {
            onError("should receive TargetPopulation message")
            return
          }

          let tp = targetPopulations.get(site)
          if (tp == null) {
            tp = new Map()
            targetPopulations.set(site, tp)
          }
          msg.populations.forEach((p) => {
            tp.set(p.species, { min: p.min, max: p.max })
          })
        }

        this.readyResolver.resolve()
        log("server socket ready")
      }
    )

    server.on("close", () => {
      this.log("server closed")
      servers.delete(site)
    })

    server.on("error", (err) => {
      this.log("server errored out", { err })
      servers.delete(site)
    })

    this.readyResolver = Promise.withResolvers()
    this.iterator = readMessage(this.socket)
  }

  async process() {
    await this.readyResolver.promise

    // target populations has been filled now

    const site = this.site
    const server = this.socket
    const iterator = this.iterator
    const onError = this.onError.bind(this)
    const log = this.log.bind(this)

    this.log("start to process")

    async function deleteExistingPolicy(policy: number) {
      // delete it
      {
        server.write(MessageEncoder.deletePolicy(policy))
        let v = await iterator.next()
        if (v.done) {
          onError("socket unexpectedly closed")
          return
        }
        const msg = v.value
        if (msg.type !== MessageType.ok) {
          onError("should get a OK message after DeletePolicy")
          return
        }
      }
    }

    const sp = sitePopulations.get(site)
    const tp = targetPopulations.get(site)
    if (sp == null || tp == null) return

    async function createPolicy(species: string, action: PolicyAction) {
      log("start to create policy", { species, action })

      let siteP = policyMap.get(site)
      if (siteP == null) {
        siteP = new Map()
        policyMap.set(site, siteP)
      }
      const p = siteP.get(species)

      // already exists same policy
      if (p != null && p.action === action) {
        log("policy alread exists, skip", { species, p })
        return
      }

      // delete old policy
      if (p != null && p.action !== action) {
        await deleteExistingPolicy(p.policy)
        siteP.delete(species)
        log("existing policy deleted", { species, p })
      }

      // create new policy
      {
        server.write(MessageEncoder.createPolicy(species, action))
        let v = await iterator.next()
        if (v.done) {
          onError("socket unexpectedly closed")
          return
        }
        const msg = v.value
        if (msg.type !== MessageType.policyResult) {
          onError("should get PolicyResult message")
          return
        }
        log("policy created", { species, action, policy: msg.policy })
        siteP.set(species, {
          policy: msg.policy,
          action,
        })
      }
    }

    for (const species of tp.keys()) {
      const mutex = this.getLock(species)
      await mutex.lock()

      // Where a species is not present in the SiteVisit, it means there were no animals of that species observed
      const count = sp.get(species) ?? 0
      const config = tp.get(species)!

      if (count < config.min) {
        log("species count is too small", { species, count, config })
        await createPolicy(species, PolicyAction.conserve)
      } else if (count > config.max) {
        log("species count is too large", { species, count, config })
        await createPolicy(species, PolicyAction.cull)
      } else {
        const siteP = policyMap.get(site)
        if (siteP) {
          // delete existing policy
          const p = siteP.get(species)
          if (p) {
            await deleteExistingPolicy(p.policy)
            siteP.delete(species)
            log("species count is within range, existing policy deleted", {
              species,
              p,
              config,
            })
          }
        }
      }

      mutex.unlock()
    }

    this.log("process done")
  }

  //
  //
  //

  getLock(species: string) {
    let mutex = this.mutexes.get(species)
    if (mutex == null) {
      mutex = new Mutex()
      this.mutexes.set(species, mutex)
    }
    return mutex
  }

  onError(msg: string) {
    this.log("onError: " + msg)
    this.socket.end(MessageEncoder.error(msg))
  }

  log(msg: string, obj?: any) {
    console.log(
      `[server:${this.site}]`,
      msg,
      ...(obj ? [JSON.stringify(obj)] : [])
    )
  }
}

let clientIdSeed = 0
const server = createServer(async (client) => {
  const clientId = clientIdSeed++
  function log(msg: string, obj?: any) {
    console.log(
      `[client:${clientId}]`,
      msg,
      ...(obj ? [JSON.stringify(obj)] : [])
    )
  }

  log("client connected")

  function onError(msg: string) {
    log("onError: " + msg)
    client.end(MessageEncoder.error(msg))
  }

  client.on("close", () => {
    log("client disconnected")
  })

  client.write(MessageEncoder.hello())

  let msgIndex = -1
  for await (const msg of readMessage(client)) {
    msgIndex++

    log("msg parsed", { msg, msgIndex })

    if (msg.type === "error") {
      onError("invalid msg")
      return
    }

    // first message must be hello
    if (msgIndex === 0) {
      if (msg.type !== MessageType.hello) {
        onError("first message must be Hello")
        return
      }

      if (msg.protocol !== "pestcontrol" || msg.version !== 1) {
        onError("invalid protocol or version")
        return
      }

      continue
    }

    if (msg.type !== MessageType.siteVisit) {
      onError("client other messages must be SiteVisit")
      return
    }

    // check siteVisit is valid
    if (!checkSiteVisitMsg(msg)) {
      onError("conflicting SiteVisit message")
      return
    }

    // everytime, we need to override the old data
    const sp = new Map()
    sitePopulations.set(msg.site, sp)

    msg.populations.forEach((p) => {
      sp.set(p.species, p.count)
    })

    let server = servers.get(msg.site)
    if (server == null) {
      server = new Server(msg.site)
      servers.set(msg.site, server)
    }

    await server!.process()
  }
})

const PORT = 8888

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`)
})

// It is an error for the populations field to contain multiple conflicting counts for the same species (but non-conflicting duplicates are allowed).
function checkSiteVisitMsg(msg: MessageSiteVisit): boolean {
  const g = _.groupBy(msg.populations, (obj) => obj.species)
  for (const key in g) {
    const arr = g[key]!
    if (arr.length === 1) {
      continue
    }

    if (new Set(arr.map((o) => o.count)).size > 1) {
      return false
    }
  }

  return true
}
