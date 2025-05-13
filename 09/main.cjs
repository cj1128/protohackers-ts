const { createServer } = require("node:net")
const assert = require("assert")
const PriorityQueue = require("priorityqueuejs")
const { z } = require("zod")

async function* readLines(socket) {
  let buffer = Buffer.alloc(0)
  for await (const chunk of socket) {
    buffer = Buffer.concat([buffer, chunk])
    let index
    while ((index = buffer.indexOf(0x0a)) !== -1) {
      const line = buffer.slice(0, index).toString()
      buffer = buffer.slice(index + 1)
      yield line
    }
  }
}

const NonNegativeInt = z.number().int().min(0)
const JobId = z.number().int()

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

function parseRequest(input) {
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

class JobCentre {
  constructor() {
    this.queues = new Map()
    this.jobs = new Map()
    this.waitingClients = new Map()
    this.workingClients = new Map()
  }

  assignJob(socket, job) {
    sendResponse(socket, {
      status: "ok",
      id: job.id,
      job: job.job,
      pri: job.pri,
      queue: job.queue,
    })
    this.workingClients.set(job.id, socket)
  }

  addJob(job) {
    this.jobs.set(job.id, job)
    const wc = this.findWaitingClient(job.queue)
    if (wc) {
      this.assignJob(wc, job)
      this.waitingClients.delete(wc)
    } else {
      let queue = this.queues.get(job.queue)
      if (queue == null) {
        queue = new PriorityQueue((a, b) => a.pri - b.pri)
        this.queues.set(job.queue, queue)
      }
      queue.enq(job)
    }
  }

  dequeueJobInQueues(queues) {
    let targetQueue
    let maxPri = -1
    for (const queueName of queues) {
      const queue = this.queues.get(queueName)
      if (queue && !queue.isEmpty()) {
        let peekJob = queue.peek()
        while (peekJob && !this.hasJob(peekJob.id)) {
          queue.deq()
          peekJob = queue.isEmpty() ? null : queue.peek()
        }
        if (peekJob && peekJob.pri > maxPri) {
          maxPri = peekJob.pri
          targetQueue = queueName
        }
      }
    }
    if (targetQueue) {
      return this.queues.get(targetQueue).deq()
    }
    return null
  }

  addWaitingClient(client, queues) {
    this.waitingClients.set(client, queues)
  }

  findWaitingClient(queue) {
    for (const [socket, queues] of this.waitingClients) {
      if (queues.includes(queue)) {
        return socket
      }
    }
    return null
  }

  hasJob(id) {
    return this.jobs.has(id)
  }

  deleteJob(id) {
    this.workingClients.delete(id)
    this.jobs.delete(id)
  }

  abortJob(id) {
    const job = this.jobs.get(id)
    assert.ok(job != null)
    assert.ok(this.workingClients.get(id) != null)
    this.addJob(job)
    this.workingClients.delete(id)
  }
}

function sendResponse(socket, obj) {
  socket.write(JSON.stringify(obj) + "\n")
}

process.on("uncaughtException", (err) => {
  console.error("Fatal uncaught exception:", err)
  // process.exit(1) 可以酌情加
})

let clientIdSeed = 0
const jc = new JobCentre()
const server = createServer(async (socket) => {
  const clientId = clientIdSeed++

  function log(...args) {
    console.log(`[${clientId}]`, ...args)
  }

  log("client connected")

  socket.on("error", (err) => {
    log("error occurred", err)
  })

  socket.on("close", () => {
    log("client disconnect")
    const jobIds = []
    jc.workingClients.forEach((client, jobId) => {
      if (client === socket) {
        jobIds.push(jobId)
      }
    })
    jobIds.forEach((id) => jc.abortJob(id))
    jc.waitingClients.delete(socket)
  })

  for await (const line of readLines(socket)) {
    const req = parseRequest(line)
    if (req == null) {
      sendResponse(socket, { status: "error", error: "Invalid request" })
      continue
    }
    switch (req.request) {
      case "put": {
        const jobId = genJobId()
        jc.addJob({ pri: req.pri, job: req.job, id: jobId, queue: req.queue })
        sendResponse(socket, { status: "ok", id: jobId })
        break
      }
      case "get": {
        const found = jc.dequeueJobInQueues(req.queues)
        if (found) {
          jc.assignJob(socket, found)
        } else if (req.wait) {
          jc.addWaitingClient(socket, req.queues)
        } else {
          sendResponse(socket, { status: "no-job" })
        }
        break
      }
      case "delete": {
        if (jc.hasJob(req.id)) {
          jc.deleteJob(req.id)
          sendResponse(socket, { status: "ok" })
        } else {
          sendResponse(socket, { status: "no-job" })
        }
        break
      }
      case "abort": {
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
        break
      }
    }
  }
})

const PORT = 8888
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`)
})
