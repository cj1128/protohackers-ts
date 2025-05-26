import { createServer, Socket, createConnection } from "node:net"
import Mutex from "p-mutex"
import _ from "lodash"
import {
  MessageEncoder,
  MessageType,
  PolicyAction,
  readMessage,
  type Message,
  type MessageSiteVisit,
} from "./msg"
import fs from "node:fs"
import { createLogger, type Logger } from "../utils"
import assert from "assert"

const authorityServers = new Map<number, AuthorityServer>()

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
  fs.mkdirSync("tmp", { recursive: true })

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

class AuthorityServer {
  private socket: Socket
  private site: number
  private readyResolver: any
  private iterator: any
  private mutex = new Mutex()
  private log: Logger

  constructor(site: number) {
    this.site = site
    this.log = createLogger(`[server:${site}]`)

    this.socket = createConnection(
      {
        host: "pestcontrol.protohackers.com",
        port: 20547,
      },
      async () => {
        const server = this.socket
        const site = this.site
        const log = this.log.bind(this)
        const onError = this.onError.bind(this)

        log("server connected")

        try {
          // no matter what, we need to send hello first
          server.write(MessageEncoder.hello())

          // first message received must be Hello
          {
            const msg = await this.nextMessage()
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

          // dial authority if no cache found
          if (targetPopulations.get(site) == null) {
            server.write(MessageEncoder.dialAuthority(site))

            const msg = await this.nextMessage()
            log("msg received", { msg })

            if (msg.type !== MessageType.targetPopulations) {
              onError("should receive TargetPopulation message")
              return
            }

            const tp = new Map()
            targetPopulations.set(site, tp)
            msg.populations.forEach((p) => {
              tp.set(p.species, { min: p.min, max: p.max })
            })
          }

          this.readyResolver.resolve()
          log("server socket ready")
        } catch (err: any) {
          onError(err.message)
          return
        }
      }
    )

    server.on("close", () => {
      this.log("server closed")
      authorityServers.delete(site)
    })

    server.on("error", (err) => {
      this.log("server errored out", { err })
      authorityServers.delete(site)
    })

    this.readyResolver = Promise.withResolvers()
    this.iterator = readMessage(this.socket)
  }

  async process() {
    // target populations has been filled after this
    await this.readyResolver.promise

    await this.mutex.lock()

    try {
      const site = this.site
      const log = this.log.bind(this)

      this.log("start to process")

      const sp = sitePopulations.get(site)
      const tp = targetPopulations.get(site)
      assert.ok(sp != null && tp != null)

      for (const species of tp.keys()) {
        // Where a species is not present in the SiteVisit, it means there were no animals of that species observed
        const count = sp.get(species) ?? 0
        const config = tp.get(species)!

        switch (true) {
          case count < config.min:
            {
              log("species count is too small", { species, count, config })
              await this.createPolicy(species, PolicyAction.conserve)
            }
            break
          case count > config.max:
            {
              log("species count is too large", { species, count, config })
              await this.createPolicy(species, PolicyAction.cull)
            }
            break
          // delete existing policy if any
          default:
            {
              const siteP = policyMap.get(site)
              const p = siteP?.get(species)
              if (p) {
                await this.deleteExistingPolicy(p.policy)
                siteP!.delete(species)
                log("species count is within range, existing policy deleted", {
                  species,
                  p,
                  config,
                })
              } else {
                log("species count is within range, no action needed", {
                  species,
                  config,
                })
              }
            }
            break
        }
      }
      this.log("process done")
    } catch (err: any) {
      this.onError(err.message)
      return
    } finally {
      this.mutex.unlock()
    }
  }

  //
  //
  //

  async deleteExistingPolicy(policy: number) {
    // delete it
    this.socket.write(MessageEncoder.deletePolicy(policy))

    const msg = await this.nextMessage()

    if (msg.type !== MessageType.ok) {
      this.onError("should get a OK message after DeletePolicy")
      return
    }
  }

  async createPolicy(species: string, action: PolicyAction) {
    const log = this.log
    const site = this.site

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
      await this.deleteExistingPolicy(p.policy)
      siteP.delete(species)
      log("existing policy deleted", { species, p })
    }

    // create new policy
    {
      this.socket.write(MessageEncoder.createPolicy(species, action))
      const msg = await this.nextMessage()
      if (msg.type !== MessageType.policyResult) {
        this.onError("should get PolicyResult message")
        return
      }
      log("policy created", { species, action, policy: msg.policy })
      siteP.set(species, {
        policy: msg.policy,
        action,
      })
    }
  }

  // will throw error
  async nextMessage(): Promise<Message> {
    const v = await this.iterator.next()
    if (v.done) {
      throw new Error("socket unexpectedly closed")
    }
    return v.value
  }

  onError(msg: string, extra?: any) {
    this.log("onError: " + msg, extra)
    this.socket.end(MessageEncoder.error(msg))
  }
}

let clientIdSeed = 0
const server = createServer(async (client) => {
  const clientId = clientIdSeed++

  const log = createLogger(`[client:${clientId}]`)

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
      onError("invalid SiteVisit message, contaisn conflicting count")
      return
    }

    // we need to override the data everytime
    {
      const sp = new Map()
      sitePopulations.set(msg.site, sp)

      msg.populations.forEach((p) => {
        sp.set(p.species, p.count)
      })
    }

    let server = authorityServers.get(msg.site)
    if (server == null) {
      server = new AuthorityServer(msg.site)
      authorityServers.set(msg.site, server)
    }

    server.process()
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
