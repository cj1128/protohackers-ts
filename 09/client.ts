import _ from "lodash"

import type { Socket } from "bun"

function createClient(): Promise<Socket> {
  return new Promise((resolve, reject) => {
    Bun.connect({
      hostname: "localhost",
      port: 8888,
      socket: {
        open(socket) {
          resolve(socket)
        },
        data() {
          // ignore
        },
        error(socket, err) {
          reject(err)
        },
      },
    })
  })
}

async function createClients(num: number) {
  const ps = _.range(num).map(createClient)
  const clients = await Promise.all(ps)
  return clients
}

// create 1000 clients
const clients = await createClients(1000)
console.log("clients created")

// insert 50,000 jobs
const jobs = []
for (let i = 0; i < 50000; i++) {
  _.sample(clients)!.write(
    JSON.stringify({
      request: "put",
      queue: "q1",
      job: { title: "job" + i },
      pri: _.random(10000),
    }) + "\n"
  )

  if (i > 0 && i % 1000 === 0) {
    console.log("1000 jobs inserted")
  }
}

console.log("all done")
