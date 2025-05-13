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

- Need to increase somaxconn in Mac `sudo sysctl kern.ipc.somaxconn=2000`
