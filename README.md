# goodfido
  
"**goodfido**" is an experimental multiplayer game platform built with Node.js, WebSockets, and Phaser.

It's not intended as a polished product but as a learning/prototyping project to explore server–client architecture, state persistence, and browser-based rendering.

## Features  
**Server**

- Node.js + WebSocket server (`server.js`)
- Lightweight JSON persistence (time, players, objects, NPCs)
- REST-style endpoints for world/room data
- Object/NPC lifecycle with respawn + behavior hooks
- Simple password-based auth with salted+hashed storage

**Client**

- Phaser 3 runtime (`client_main.js`)
- Tile-based room rendering
- Player movement, emotes, and collisions
- Object pickup/drop, NPC interactions
- Context menus, floating console, and character info overlay (`ui.js`)

Consistency enforced with ESLint + Prettier.

## Quickstart

### Prerequisites

- [Node.js](https://nodejs.org/) (LTS recommended, v18+)

- npm / yarn

### Install
`git clone https://github.com/wsshaw/goodfido.git`
`cd goodfido`
`npm install`

### Run
`node server.js`

...and visit http://localhost:8081/.