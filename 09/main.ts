import { createServer, Socket } from "node:net"
import assert from "assert"
import PriorityQueue from "priorityqueuejs"
import { readLines } from "../utils"
import { z } from "zod"

const NonNegativeInt = z.number().int().min(0)
const JobId = z.number().int()
type JobId = z.infer<typeof JobId>

const PutReq = z.object({
  request: z.literal("put"),
  queue: z.string(),
  job: z.record(z.any()),
  pri: NonNegativeInt,
})
const GetReq = z.object({
  request: z.literal("get"),
  queues: z.array(z.string()),
  wait: z.boolean().optional(),
})
const DeleteReq = z.object({
  request: z.literal("delete"),
  id: JobId,
})
const AbortReq = z.object({
  request: z.literal("abort"),
  id: JobId,
})

const Request = z.union([PutReq, GetReq, DeleteReq, AbortReq])

type Request = z.infer<typeof Request>

function parseRequest(input: string): Request | null {
  try {
    const obj = JSON.parse(input)
    return Request.parse(obj)
  } catch (err) {
    return null
  }
}

let jobIdSeed = 0
function genJobId() {
  return jobIdSeed++
}

type Job = {
  pri: number
  job: any
  id: JobId
  queue: string
}

type WaitingClient = {
  socket: Socket
  queues: string[]
}

class JobCentre {
  private queues = new Map<string, PriorityQueue<Job>>()
  // key: jobId
  private jobs = new Map<number, Job>()

  waitingClients = new Map<Socket, string[]>()
  workingClients = new Map<number, Socket>()

  assignJob(socket: Socket, job: Job) {
    sendResponse(socket, {
      status: "ok",
      id: job.id,
      job: job.job,
      pri: job.pri,
      queue: job.queue,
    })
    this.workingClients.set(job.id, socket)
  }

  addJob(job: Job) {
    this.jobs.set(job.id, job)

    // check if there is a waiting client
    const wc = this.findWaitingClient(job.queue)
    if (wc) {
      this.assignJob(wc, job)
      this.waitingClients.delete(wc)
    } else {
      // enqueue
      let queue = this.queues.get(job.queue)
      if (queue == null) {
        queue = new PriorityQueue<Job>((a, b) => a.pri - b.pri)
        this.queues.set(job.queue, queue)
      }
      queue.enq(job)
    }
  }

  dequeueJobInQueues(queues: string[]): Job | null {
    let targetQueue
    let maxPri = -1
    for (const queueName of queues) {
      const queue = this.queues.get(queueName)
      if (queue && !queue.isEmpty()) {
        let peekJob: Job | null = queue.peek()

        // NOTE: must check whether the job is existed
        while (peekJob && !this.hasJob(peekJob.id)) {
          queue.deq() // remove this job
          if (!queue.isEmpty()) {
            peekJob = queue.peek()
          } else {
            peekJob = null
          }
        }

        if (peekJob && peekJob.pri > maxPri) {
          maxPri = peekJob.pri
          targetQueue = queueName
        }
      }
    }

    if (targetQueue) {
      return this.queues.get(targetQueue)!.deq()!
    }

    return null
  }

  addWaitingClient(client: Socket, queues: string[]) {
    this.waitingClients.set(client, queues)
  }
  findWaitingClient(queue: string): Socket | null {
    for (const [socket, queues] of this.waitingClients) {
      if (queues.includes(queue)) {
        return socket
      }
    }
    return null
  }

  hasJob(id: number): boolean {
    return this.jobs.has(id)
  }

  // return true if job exists
  deleteJob(id: number) {
    this.workingClients.delete(id)
    // NOTE: will not delete job in queues (it's complicated to do, so we will add check when get job from queue)
    this.jobs.delete(id)
  }

  abortJob(id: number) {
    const job = this.jobs.get(id)

    assert.ok(job != null)
    assert.ok(this.workingClients.get(id) != null)

    this.addJob(job)
    this.workingClients.delete(id)
  }
}

function sendResponse(socket: Socket, obj: object) {
  socket.write(JSON.stringify(obj) + "\n", (err) => {})
}

let clientIdSeed = 0
const jc = new JobCentre()
const server = createServer(async (socket) => {
  const clientId = clientIdSeed++

  log("client connected")

  function log(...args: any[]) {
    console.log(`[${clientId}]`, ...args)
  }

  socket.on("error", (err) => {
    log(`error occurred`, err)
  })

  socket.on("close", () => {
    log("client disconnect")

    // abort all working jobs
    {
      const jobIds: number[] = []
      // NOTE: this is not optimal (linear iteration), but it's accpetable for this program
      jc.workingClients.forEach((client, jobId) => {
        if (client === socket) {
          jobIds.push(jobId)
        }
      })
      jobIds.forEach((id) => jc.abortJob(id))
    }

    // remove from workingClients list
    jc.waitingClients.delete(socket)
  })

  for await (const line of readLines(socket)) {
    const req = parseRequest(line)
    // log("req received", req)

    // invalid
    if (req == null) {
      sendResponse(socket, { status: "error", error: "Invalid request" })
      continue
    }

    switch (req.request) {
      case "put":
        {
          const jobId = genJobId()
          jc.addJob({
            pri: req.pri,
            job: req.job,
            id: jobId,
            queue: req.queue,
          })
          sendResponse(socket, { status: "ok", id: jobId })
        }
        break
      case "get":
        {
          const found = jc.dequeueJobInQueues(req.queues)

          if (found) {
            jc.assignJob(socket, found)
            // log("job assigned", found)
          } else if (req.wait) {
            // log("wait for a job")
            jc.addWaitingClient(socket, req.queues)
          } else {
            // log("no job found")
            sendResponse(socket, { status: "no-job" })
          }
        }
        break
      case "delete":
        {
          if (jc.hasJob(req.id)) {
            jc.deleteJob(req.id)
            sendResponse(socket, { status: "ok" })
          } else {
            sendResponse(socket, { status: "no-job" })
          }
        }
        break
      case "abort":
        {
          if (!jc.hasJob(req.id)) {
            sendResponse(socket, { status: "no-job" })
          } else if (jc.workingClients.get(req.id) === socket) {
            jc.abortJob(req.id)
            sendResponse(socket, { status: "ok" })
          } else {
            sendResponse(socket, {
              status: "error",
              error: "client not working on this job",
            })
          }
        }
        break
    }
  }
})

const PORT = 8888

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`)
})
