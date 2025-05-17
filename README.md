# [Protohackers](https://protohackers.com/) in TypeScript

Bun + TypeScript, every server is listening on port 8888.

## 00 Smoke Test

- A simple TCP Echo Service from RFC 862.

## 01 Prime Time

- A custom `readLines` function is handy

## 02 Means to an End

- A custom `SlidingBufferReader` is handy

## 03 Budget Chat

- A custom `LineReader` based on `SlidingBufferReader` is handy

## 04 Unusual Database Program

- NOTE: in Node, the "message" event always corresponds to a single UDP packet

## 05 Mob in the Middle

- I cann't believe how short the code is

## 06 Speed Daemon

- Packet parsing needs some work but it's straightforward
- Need to write a client to send bytes to test the server, `bun run tools/tcp_hex_client.ts`

## 07 Line Reversal

- How to build a reliable byte stream over UDP? and how to provide this abstraction to application layer?

## 08 Insecure Sockets Layer

- Main work is to implement the cipher, it's not complex

## 09 Job Centre

- for previous problems, I was using my home computer with router port forwarding to do the test, but this one involves large connections (1000 clients) and it seems that my router can not handle this much connections. So for this test, I need to use a server to do the test.
- `bun build --target=bun main.ts --outfile=bundle.js` to bundle the code and run it in the server

## 10: Voracious Code Storage

- DO not use telent, "\r\n"

```
> x
> ← Received: ERR illegal method: x

> help
> ← Received: OK usage: HELP|GET|PUT|LIST
> ← Received: READY

> ← Received: ERR usage: GET file [revision]
READY
> get /a r2
> ← Received: OK 1
> ← Received: aREADY
> get /a r3
> ← Received: OK 10
helloworldREADY
> get /a r4
> ← Received: ERR no such revision
READY




> put
> ← Received: ERR usage: PUT file length newline data
> ← Received: READY
> put abc 10
> ← Received: ERR illegal file name
>
> put /a 0
> ← Received: OK r4
READY
> put /a -1
> ← Received: OK r4
READY
> put /a 2
> abc
> ← Received: OK r5
READY
ERR illegal method: c



> list
> ← Received: ERR usage: LIST dir
> ← Received: READY

```
