/**
 * good-fido: Client runtime, so to speak (Phaser.js + DOM UI)
 * -----------------------------------------------------------------------
 * - Bootstraps asset/animation/physics metadata, then starts Phaser scene.
 * - Connects to server via WebSocket and renders players, NPCs, objects.
 * - Handles room transitions, simple physics, emotes, SFX, and UI overlays.
 *
 * Key client concepts
 * - World/Rooms: pulled via `/api` endpoints; current room held in `zone`.
 * - Sprites: bottom-center aligned to tiles; labels track sprite positions.
 * - Movement: local player uses arcade physics; remotes tween to positions.
 * - Objects/NPCs: spawned from server init + subsequent deltas.
 * - Context Menus: objects & NPCs expose simple right-click/inspect actions.
 */
import {
  createCharInfoOverlay,
  createFloatingConsole,
  openInspectorPanel,
  removeCharInfoOverlay,
  showTerrainSelector,
  updateConsoleLayout,
  updateEditGrid,
  updateInventoryUI,
} from './ui.js';

// --- PHYSICS RULES LOADING ---
// Global object to hold loaded physics rules
let physicsRules = {};

// --- ANIMATION DEFINITIONS LOADING ---
// Global object to hold loaded animation definitions
let animations = {};

// Load properties.json at startup (before game boot); contains physics templates etc for
// objects in the world
fetch('/properties.json')
  .then((res) => res.json())
  .then((data) => {
    physicsRules = data;
    // physicsRules now available globally
  })
  .catch((e) => {
    console.error('Failed to load properties.json', e);
  });

// Load animations.json at startup (before game boot)
fetch('/animations.json')
  .then((res) => res.json())
  .then((data) => {
    animations = data;
    // animations now available globally
  })
  .catch((e) => {
    console.error('Failed to load animations.json', e);
  });
// --- TILE IMAGE/ANIMATION DRAWING FOR CANVAS RENDERING ---
/**
 * Draw one animation frame for a tile-sized visual on the canvas layer.
 * Uses `performance.now()` and `animDef.frameLength` (ms) to choose frame.
 * @param {CanvasRenderingContext2D} ctx
 * @param {{frames:string[], frameLength?:number}} animDef
 * @param {number} x - pixel x
 * @param {number} y - pixel y
 */
function drawAnimationFrame(ctx, animDef, x, y) {
  if (!animDef || !Array.isArray(animDef.frames) || animDef.frames.length === 0) return;
  // Animation timing: Use performance.now() for smoothness
  const now = performance.now();
  // animDef.frameLength is in ms per frame (default 200ms)
  const frameLength = animDef.frameLength || 200;
  const totalFrames = animDef.frames.length;
  // Calculate which frame to use
  const currentFrameIdx = Math.floor(now / frameLength) % totalFrames;
  const frameKey = animDef.frames[currentFrameIdx];
  // tileImages is assumed to be a global mapping (as in tiles.js)
  const img = window.tileImages?.[frameKey];
  if (img) {
    ctx.drawImage(img, x, y);
  }
}
// Prevent repeated room-transition handling
let transitionInProgress = false;
// Flag for world-edit mode (wizard-only)

let editMode = false;
let debugBodyGraphics = null;

let objectTypes = {}; // will map typeId → object type definition (including sprite key)

// --- Player inventory ---
let myInventory = [];
// Temporary store of instances awaiting server confirmation
let pendingPickupInstances = {};
// --- Character Info Overlay ---
let charInfoEl = null;

let pendingNPCs = [];
const gameFont = 'Solway';

/** Append a line of text to the floating in-page console (and auto-scroll). */
function log(msg) {
  createFloatingConsole();
  const logPanel = document.getElementById('log-panel');
  const line = document.createElement('div');
  line.textContent = msg;
  logPanel.appendChild(line);
  // Keep log panel scrolled to bottom
  logPanel.scrollTop = logPanel.scrollHeight;
  //console.log(msg);
}

/**
 * Choose & play a directional walk cycle based on Δx/Δy.
 * Records `sprite.lastDirection` for later idle pose selection.
 * @returns {'up'|'down'|'left'|'right'}
 */
function playMovementAnimation(sprite, dx, dy) {
  // Determine primary direction of movement
  let direction = 'down';
  if (Math.abs(dx) > Math.abs(dy)) {
    direction = dx > 0 ? 'right' : 'left';
  } else if (Math.abs(dy) > 0) {
    direction = dy > 0 ? 'down' : 'up';
  }

  // Attempt to play a spritesheet-based animation for this sprite
  const keyRoot = sprite.texture.key;
  const walkKey = `${keyRoot}-walk-${direction}`;
  if (sprite.anims && sprite.anims.animationManager.exists(walkKey)) {
    if (!sprite.anims.isPlaying || sprite.anims.currentAnim?.key !== walkKey) {
      sprite.anims.play(walkKey, true);
    }
  }
  // Record last direction for returning to idle later
  sprite.lastDirection = direction;
  return direction;
}
/**
 * Render a transient speech-bubble above a player/NPC sprite.
 * Reuses one bubble per instanceId and auto-fades after delay.
 * @param {string|number} instanceId
 * @param {string} text
 */
function showEmote(instanceId, text) {
  if (!currentScene) return;
  // Find the sprite: players (by numeric id) or npcSprites
  const sprite = players[instanceId] || npcSprites[instanceId];
  if (!sprite) return;
  // If a previous emote bubble exists, remove it immediately
  const existing = emoteBubbles[instanceId];
  if (existing) {
    existing.destroy();
    delete emoteBubbles[instanceId];
  }

  const maxWidth = TILE_SIZE * 4;
  const maxHeight = TILE_SIZE * 2;
  // Create text object with wrapping
  const style = {
    fontFamily: gameFont,
    fontSize: '12px',
    color: '#ffffff',
    align: 'center',
    wordWrap: { width: maxWidth, useAdvancedWrap: true },
  };
  const emoteText = currentScene.add.text(0, 0, text, style);
  // Clamp size
  const textWidth = Math.min(emoteText.width, maxWidth);
  const textHeight = Math.min(emoteText.height, maxHeight);
  emoteText.setFixedSize(textWidth, textHeight);

  // Background rounded rect
  const padding = 6;
  const bgWidth = textWidth + padding * 2;
  const bgHeight = textHeight + padding * 2;
  const bg = currentScene.add.graphics();
  bg.fillStyle(0x000000, 0.6);
  bg.fillRoundedRect(-bgWidth / 2, -bgHeight / 2, bgWidth, bgHeight, 6);
  // draw pointer triangle below the bubble
  const pointerWidth = 12;
  const pointerHeight = 8;
  bg.fillTriangle(
    -pointerWidth / 2,
    bgHeight / 2,
    pointerWidth / 2,
    bgHeight / 2,
    0,
    bgHeight / 2 + pointerHeight
  );

  // Position bubble so triangle apex touches the top of the sprite
  const bubbleX = sprite.x + TILE_SIZE / 2;
  const bubbleY = sprite.y - (bgHeight / 2 + pointerHeight);
  const container = currentScene.add.container(bubbleX, bubbleY, [bg, emoteText]);
  // Remember offset for future repositioning
  container.bubbleOffset = bgHeight / 2 + pointerHeight;
  emoteText.setPosition(-textWidth / 2, -textHeight / 2);
  // Keep track so we can reposition it when the sprite moves
  emoteBubbles[instanceId] = container;

  // Fade in, hold, then fade out
  container.setAlpha(0);
  currentScene.tweens.add({
    targets: container,
    alpha: 1,
    duration: 200,
    onComplete: () => {
      currentScene.time.delayedCall(2000, () => {
        currentScene.tweens.add({
          targets: container,
          alpha: 0,
          duration: 200,
          onComplete: () => {
            container.destroy();
            // Only remove from map if it hasn't been replaced by a new bubble
            if (emoteBubbles[instanceId] === container) {
              delete emoteBubbles[instanceId];
            }
          },
        });
      });
    },
  });
}

// Track active emote bubbles keyed by instanceId
const emoteBubbles = {};
const _debug = false;

const ws = new WebSocket('ws://localhost:8081');

const loadingOverlay = document.createElement('div');
loadingOverlay.style.position = 'absolute';
loadingOverlay.style.top = 0;
loadingOverlay.style.left = 0;
loadingOverlay.style.width = '100vw';
loadingOverlay.style.height = '100vh';
loadingOverlay.style.background = 'rgba(0, 0, 0, 0.8)';
loadingOverlay.style.display = 'flex';
loadingOverlay.style.alignItems = 'center';
loadingOverlay.style.justifyContent = 'center';
loadingOverlay.style.zIndex = 9999;
loadingOverlay.innerHTML = `<div style="color: white; font-size: 64px; font-family:${gameFont};">Loading…</div>`;
document.body.appendChild(loadingOverlay);

// --- Player name input form ---
const nameForm = document.createElement('form');
nameForm.style.position = 'absolute';
nameForm.style.top = '50%';
nameForm.style.left = '50%';
nameForm.style.transform = 'translate(-50%, -50%)';
nameForm.style.background = '#222';
nameForm.style.padding = '20px';
nameForm.style.border = '2px solid #aaa';
nameForm.style.borderRadius = '8px';
nameForm.style.display = 'flex';
nameForm.style.flexDirection = 'column';
nameForm.style.alignItems = 'center';
nameForm.style.zIndex = '1000';
nameForm.style.fontFamily = gameFont;
const errorDiv = document.createElement('div');
errorDiv.style.color = 'red';
errorDiv.style.marginBottom = '10px';
errorDiv.style.display = 'none';
nameForm.appendChild(errorDiv);
const nameInput = document.createElement('input');
nameInput.type = 'text';
nameInput.placeholder = 'Enter your name';
nameInput.style.marginBottom = '10px';
nameInput.style.padding = '8px';
nameInput.style.fontSize = '16px';
nameInput.style.fontFamily = gameFont;

const passwordInput = document.createElement('input');
passwordInput.type = 'password';
passwordInput.placeholder = 'Enter your password';
passwordInput.style.marginBottom = '10px';
passwordInput.style.padding = '8px';
passwordInput.style.fontSize = '16px';
passwordInput.style.fontFamily = gameFont;

const submitButton = document.createElement('button');
submitButton.type = 'submit';
submitButton.textContent = 'Join';
submitButton.style.padding = '8px 16px';
submitButton.style.fontSize = '16px';
submitButton.style.cursor = 'pointer';
submitButton.style.fontFamily = gameFont;

const createButton = document.createElement('button');
createButton.type = 'button';
createButton.textContent = 'Create New Character';
createButton.style.marginTop = '10px';
createButton.style.padding = '8px 16px';
createButton.style.fontSize = '16px';
createButton.style.cursor = 'pointer';
createButton.style.fontFamily = gameFont;

nameForm.appendChild(nameInput);
nameForm.appendChild(passwordInput);
nameForm.appendChild(submitButton);
nameForm.appendChild(createButton);

/*nameForm.appendChild(nameInput);
nameForm.insertBefore(passwordInput, submitButton);
nameForm.appendChild(submitButton);
nameForm.appendChild(createButton);*/
document.body.appendChild(nameForm);

const createForm = document.createElement('form');
createForm.style.position = 'absolute';
createForm.style.top = '50%';
createForm.style.left = '50%';
createForm.style.transform = 'translate(-50%, -50%)';
createForm.style.background = '#222';
createForm.style.padding = '20px';
createForm.style.border = '2px solid #aaa';
createForm.style.borderRadius = '8px';
createForm.style.display = 'none';
createForm.style.flexDirection = 'column';
createForm.style.alignItems = 'center';
createForm.style.zIndex = '1000';

const newName = document.createElement('input');
newName.type = 'text';
newName.placeholder = 'Character Name';
newName.style.marginBottom = '10px';
newName.style.padding = '8px';
newName.style.fontSize = '16px';
newName.style.fontFamily = gameFont;

const newPass = document.createElement('input');
newPass.type = 'password';
newPass.placeholder = 'Password';
newPass.style.marginBottom = '10px';
newPass.style.padding = '8px';
newPass.style.fontSize = '16px';
newPass.style.fontFamily = gameFont;

const confirmPass = document.createElement('input');
confirmPass.type = 'password';
confirmPass.placeholder = 'Confirm Password';
confirmPass.style.marginBottom = '10px';
confirmPass.style.padding = '8px';
confirmPass.style.fontSize = '16px';
confirmPass.style.fontFamily = gameFont;

const dropdown1 = document.createElement('select');
dropdown1.style.marginBottom = '10px';
['Option 1', 'Option 2'].forEach((text) => {
  const opt = document.createElement('option');
  opt.value = text;
  opt.textContent = text;
  dropdown1.appendChild(opt);
});
dropdown1.style.fontFamily = gameFont;

const dropdown2 = document.createElement('select');
dropdown2.style.marginBottom = '10px';
['Lorem', 'Ipsum'].forEach((text) => {
  const opt = document.createElement('option');
  opt.value = text;
  opt.textContent = text;
  dropdown2.appendChild(opt);
});
dropdown2.style.fontFamily = gameFont;

const createSubmit = document.createElement('button');
createSubmit.type = 'submit';
createSubmit.textContent = 'Create Character';
createSubmit.style.padding = '8px 16px';
createSubmit.style.fontSize = '16px';
createSubmit.style.fontFamily = gameFont;

createForm.appendChild(newName);
createForm.appendChild(newPass);
createForm.appendChild(confirmPass);
createForm.appendChild(dropdown1);
createForm.appendChild(dropdown2);
createForm.appendChild(createSubmit);
document.body.appendChild(createForm);

createButton.addEventListener('click', () => {
  nameForm.style.display = 'none';
  createForm.style.display = 'flex';
});

nameForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = nameInput.value.trim();
  const password = passwordInput.value.trim();
  if (name && password) {
    ws.send(JSON.stringify({ name, password, create: false }));
    nameForm.remove();
    const gameDiv = document.getElementById('game');
    if (gameDiv) gameDiv.style.visibility = 'visible';
  }
});

// --- Character creation form submit handling ---
createForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = newName.value.trim();
  const password = newPass.value.trim();
  const confirm = confirmPass.value.trim();

  if (!name || !password) {
    alert('Name and password are required.');
    return;
  }
  if (password !== confirm) {
    alert('Passwords do not match.');
    return;
  }

  if (ws.readyState === WebSocket.OPEN) {
    const payload = { name, password, create: true };
    if (_debug) console.log('Sending new character payload:', payload);
    ws.send(JSON.stringify(payload));
    createForm.remove();
  } else {
    alert('Connection not ready. Please try again.');
  }
});
const zone = { rooms: {}, currentRoomX: 0, currentRoomY: 0 };

// Load world manifest and room data via HTTP API
async function loadWorldData() {
  //log("Requesting world data.");
  const manifest = await fetch('/api/world').then((r) => r.json());
  //log(JSON.stringify(manifest));
  // Clear existing rooms
  zone.rooms = {};
  zone.defs = manifest.zones; // save for future reference
  for (const [zoneId, zoneDef] of Object.entries(manifest.zones)) {
    zoneDef.id = parseInt(zoneId, 10);
    const index = await fetch(`/api/${zoneDef.path}/index.json`).then((r) => r.json());
    for (const roomInfo of index.rooms) {
      const roomData = await fetch(`/api/${zoneDef.path}/${roomInfo.id}.json`).then((r) =>
        r.json()
      );
      zone.rooms[`${zoneDef.id},${roomInfo.id}`] = roomData;
    }
  }
}

function getCurrentRoom() {
  return zone.rooms[`${zone.currentRoomX},${zone.currentRoomY}`];
}

const TILE_SIZE = 32;

// Physics group for void tile collisions
let voidLayer = null;

let assets = {};

let cursors;
let zoomLevel = 1.5;
const MAX_ZOOM = 3,
  MIN_ZOOM = 0.5;

let currentScene = null;
// currently playing ambient sound
let currentAmbience = null;
// --- Sound playback for tile physics rules ---
let currentSound = null;

/**
 * Stop any existing ambience and play the room's base_ambience on loop
 */
function playRoomAmbience(room) {
  if (currentAmbience) {
    currentAmbience.stop();
  }
  if (room.base_ambience) {
    currentAmbience = currentScene.sound.add(room.base_ambience, { loop: true, volume: 0.5 });
    currentAmbience.play();
  }
}
let lastDirection = 'down';
let sceneReady = false,
  preloadDone = false,
  localSpriteReady = false;
let players = {},
  playerTiles = {},
  playerId = null;

// --- Object sprite management ---
const objectSprites = {}; // map: instanceId -> Phaser GameObject
// --- NPC sprite management ---
const npcSprites = {};

/**
 * Instantiate a world object sprite (animated or static) at instance coords.
 * Registers interactivity for context menu and adds a small pop-in tween.
 * @param {{instanceId:string,typeId:string|number,x:number,y:number}} instance
 */
function addObject(instance) {
  if (!currentScene) return;
  const def = objectTypes[instance.typeId] || {};
  const key = def.sprite;
  const px = instance.x * TILE_SIZE + TILE_SIZE / 2;
  const py = instance.y * TILE_SIZE + TILE_SIZE / 2;
  let spriteObj;
  // Check for animated flag in object definition

  log(`add object: ${JSON.stringify(def)}`);
  if (def.animated) {
    log(`it's animated.`);
    // Expect sprite sheet is named with _sheet suffix and already loaded
    //const sheetKey = def.sprite + '_sheet';
    // Create animation if not already defined
    if (!currentScene.anims.exists(def.sprite + '_anim')) {
      const frames = [];
      for (let i = 0; i < def.frameCount; i++) {
        log(`pushed frame  ${i}.`);
        frames.push({ key: key, frame: i });
      }
      currentScene.anims.create({
        key: def.sprite + '_anim',
        frames: frames,
        frameRate: def.frameRate || 4,
        repeat: -1,
      });
    }
    spriteObj = currentScene.add.sprite(px, py, key).setDisplaySize(TILE_SIZE, TILE_SIZE);
    spriteObj.play(def.sprite + '_anim');
    // apply default alpha and depth if specified in asset definitions
    const a = assets[key] || {};
    if (a.defaultAlpha !== undefined) spriteObj.setAlpha(a.defaultAlpha);
    if (a.defaultZ !== undefined) spriteObj.setDepth(a.defaultZ);
  } else if (key && currentScene.textures.exists(key)) {
    spriteObj = currentScene.add.image(px, py, key).setDisplaySize(TILE_SIZE, TILE_SIZE);
    // apply default alpha and depth if specified in asset definitions
    const a = assets[key] || {};
    if (a.defaultAlpha !== undefined) spriteObj.setAlpha(a.defaultAlpha);
    if (a.defaultZ !== undefined) spriteObj.setDepth(a.defaultZ);
  } else {
    // fallback circle
    spriteObj = currentScene.add.circle(px, py, TILE_SIZE / 3, 0xffd700).setDepth(1);
  }
  objectSprites[instance.instanceId] = spriteObj;

  // pop-in animation
  spriteObj.setScale(0);
  currentScene.tweens.add({
    targets: spriteObj,
    scaleX: 1,
    scaleY: 1,
    duration: 200,
    ease: 'Back.easeOut',
  });

  // make object clickable for context menu
  spriteObj.setInteractive();
  spriteObj.on('pointerdown', (pointer) => {
    // Prevent this click from closing the menu immediately
    pointer.event.stopPropagation();
    // show pick-up menu at click location (pass screen coordinates)
    showObjectContextMenu(instance, pointer.event.clientX, pointer.event.clientY);
  });
}

/** Animate-out and remove an object sprite by instance id. */
function removeObject(instanceId) {
  const sprite = objectSprites[instanceId];
  if (sprite) {
    // pop-out animation then destroy
    currentScene.tweens.add({
      targets: sprite,
      scaleX: 0,
      scaleY: 0,
      duration: 200,
      ease: 'Back.easeIn',
      onComplete: () => {
        sprite.destroy();
        delete objectSprites[instanceId];
      },
    });
  }
}

/** Destroy and forget all rendered object sprites (used on room changes). */
function clearObjects() {
  for (const id in objectSprites) {
    objectSprites[id].destroy();
  }
  Object.keys(objectSprites).forEach((id) => delete objectSprites[id]);
}

// --- NPC sprite management ---
/**
 * Create an NPC sprite at tile coords and register context menu behavior.
 * Falls back to a simple circle if texture is missing.
 * @param {{instanceId:string,name:string,sprite:string,x:number,y:number,description?:string}} npc
 */
function addNPC(npc) {
  if (!currentScene) return;
  let sprite;
  if (currentScene.textures.exists(npc.sprite)) {
    // spawn at origin, then position via shared helper
    sprite = currentScene.physics.add
      .sprite(0, 0, npc.sprite)
      .setDisplaySize(TILE_SIZE, TILE_SIZE)
      .setOrigin(0);
    // Position exactly as players do
    positionSprite(sprite, npc.x, npc.y, currentScene);
    if (sprite.anims) {
      sprite.anims.play(`${npc.sprite}-idle-down`, true);
      sprite.lastDirection = 'down';
    }
  } else {
    // fallback circle if sprite missing
    sprite = currentScene.add.circle(0, 0, TILE_SIZE / 2, 0x0000ff).setDepth(1);
    currentScene.physics.add.existing(sprite, true);
    // Position fallback the same way
    positionSprite(sprite, npc.x, npc.y, currentScene);
  }
  if (sprite.body) {
    sprite.body.setImmovable(true);
    sprite.body.moves = false;
  }
  npcSprites[npc.instanceId] = sprite;
  // Make NPC clickable for context menu
  sprite.setInteractive();
  sprite.on('pointerdown', (pointer) => {
    // Prevent this click from closing other menus
    pointer.event.stopPropagation();
    showNPCContextMenu(npc, pointer.event.clientX, pointer.event.clientY);
  });
}

/** Remove all NPC sprites from the scene (before respawn/init). */
function clearNPCs() {
  // Log keys rather than trying to stringify sprite objects
  for (const sprite of Object.values(npcSprites)) {
    sprite.destroy();
  }
  for (const id of Object.keys(npcSprites)) {
    delete npcSprites[id];
  }
}

/**
 * Build a lightweight context menu for objects (Pick up / Examine).
 * Sends `pickup` to server and updates local optimistic UI on click.
 */
function showObjectContextMenu(instance, x, y) {
  // remove existing menu if any
  const old = document.getElementById('object-menu');
  if (old) old.remove();
  // create menu container
  const menu = document.createElement('div');
  menu.id = 'object-menu';
  Object.assign(menu.style, {
    position: 'absolute',
    left: x + 'px',
    top: y + 'px',
    background: '#333',
    color: '#fff',
    border: '2px solid #444',
    borderRadius: '8px',
    padding: '4px',
    zIndex: 10000,
    cursor: 'default',
  });
  // pick-up option
  const pick = document.createElement('div');
  pick.textContent = 'Pick up';
  pick.style.padding = '4px';
  pick.style.cursor = 'pointer';
  pick.addEventListener('click', () => {
    // send pickup to server
    ws.send(
      JSON.stringify({
        type: 'pickup',
        instanceId: instance.instanceId,
        zone: zone.currentRoomX,
        roomId: zone.currentRoomY,
      })
    );
    // optimistically remove from world and stash instance for confirmation
    if (instance.instanceId) {
      removeObject(instance.instanceId);
      pendingPickupInstances[instance.instanceId] = instance;
    } else {
      console.warn('Missing instanceId on object', instance);
    }
    menu.remove();
  });
  menu.appendChild(pick);

  // "Examine" action for objects
  const examineObj = document.createElement('div');
  examineObj.textContent = 'Examine';
  examineObj.style.padding = '4px';
  examineObj.style.cursor = 'pointer';
  examineObj.addEventListener('click', () => {
    const def = objectTypes[instance.typeId] || {};
    openInspectorPanel({
      name: def.name || 'Unknown',
      spriteKey: def.sprite,
      description: def.description,
    });
    menu.remove();
  });
  menu.appendChild(examineObj);

  document.body.appendChild(menu);
  // Prevent clicks inside the menu from closing it immediately
  menu.addEventListener('click', (e) => e.stopPropagation());
  // click outside to close (ignore the first click that opened the menu)
  let ignoreFirstClick = true;
  function onBodyClick(e) {
    if (ignoreFirstClick) {
      ignoreFirstClick = false;
      return;
    }
    if (!menu.contains(e.target)) {
      menu.remove();
      document.removeEventListener('click', onBodyClick);
    }
  }
  document.addEventListener('click', onBodyClick);
}

/**
 * Render an NPC context menu (Examine/Talk) and request server-provided
 * dynamic options via `get-context-menu` for additional actions.
 */
function showNPCContextMenu(npc, x, y) {
  // Remove any existing NPC menu
  const old = document.getElementById('npc-menu');
  if (old) old.remove();
  // Create menu container
  const menu = document.createElement('div');
  menu.id = 'npc-menu';
  Object.assign(menu.style, {
    position: 'absolute',
    left: x + 'px',
    top: y + 'px',
    background: '#333',
    fontFamily: gameFont,
    fontSize: '16px',
    fontWeight: '200',
    color: '#fff',
    border: '2px solid #444',
    borderRadius: '8px',
    padding: '6px',
    zIndex: 10000,
    cursor: 'default',
  });
  // NPC icon
  const img = document.createElement('img');
  img.src = assets[npc.sprite]?.src || '';
  img.width = TILE_SIZE;
  img.height = TILE_SIZE;
  img.style.display = 'block';
  img.style.marginBottom = '4px';
  menu.appendChild(img);
  // NPC name
  const title = document.createElement('div');
  title.innerHTML = '<span style="font-size:1.2em;"><b>' + npc.name + '</b></span>' || npc.sprite;
  title.style.marginBottom = '8px';
  title.style.borderBottomColor = '#ffffff';
  title.style.borderBottomWidth = '1px';
  menu.appendChild(title);
  // "Examine" action
  const examine = document.createElement('div');
  examine.textContent = 'Examine';
  examine.style.padding = '4px';
  examine.style.cursor = 'pointer';
  /*examine.addEventListener('click', () => {
   ws.send(JSON.stringify({
      type: 'context-action',
      action: 'examine',
      targetType: 'npc',
      instanceId: npc.instanceId
    }));
    */
  examine.addEventListener('click', () => {
    openInspectorPanel({
      name: npc.name,
      spriteKey: npc.sprite,
      description: npc.description,
    });
    menu.remove();
  });
  menu.appendChild(examine);

  // "Talk" action
  const talk = document.createElement('div');
  talk.textContent = 'Talk';
  talk.style.padding = '4px';
  talk.style.cursor = 'pointer';
  talk.addEventListener('click', () => {
    ws.send(
      JSON.stringify({
        type: 'context-action',
        action: 'talk',
        targetType: 'npc',
        instanceId: npc.instanceId,
      })
    );
    menu.remove();
  });
  menu.appendChild(talk);
  // HOLDME
  ws.send(
    JSON.stringify({
      type: 'get-context-menu',
      targetType: 'npc',
      instanceId: npc.instanceId,
    })
  );
  document.body.appendChild(menu);
  // Prevent clicks inside the menu from closing it immediately
  menu.addEventListener('click', (e) => e.stopPropagation());
  // click outside to close (ignore the first click that opened the menu)
  let ignoreFirstClick = true;
  function onBodyClick(e) {
    if (ignoreFirstClick) {
      ignoreFirstClick = false;
      return;
    }
    if (!menu.contains(e.target)) {
      menu.remove();
      document.removeEventListener('click', onBodyClick);
    }
  }
  document.addEventListener('click', onBodyClick);
}
let pendingPlayers = [];

let lastRoomX = 0,
  lastRoomY = 0;
let initData = null;
let movementInProgress = false;
let gridGraphics = null;

/**
 * Compute letterbox offsets so small rooms can be centered in viewport.
 * @returns {{offsetX:number, offsetY:number, centered:boolean}}
 */
function getWorldOffset(scene) {
  const room = getCurrentRoom();
  const cam = scene.cameras.main;
  const worldWidth = room.width * TILE_SIZE;
  const worldHeight = room.height * TILE_SIZE;
  const offsetX = Math.max(0, (cam.width - worldWidth) / 2);
  const offsetY = Math.max(0, (cam.height - worldHeight) / 2);
  const centered = cam.width > worldWidth && cam.height > worldHeight;
  return { offsetX, offsetY, centered };
}
/** Back-compat alias; prefer `getWorldOffset`. */
function getRoomOffset(scene) {
  return getWorldOffset(scene);
}

/**
 * Position any sprite at the bottom-center of a tile and realign its body.
 * Also repositions attached name labels (if present).
 */
function positionSprite(sprite, tileX, tileY, scene) {
  // Position sprite by its bottom-center at the tile’s bottom-center
  const worldX = tileX * TILE_SIZE + TILE_SIZE / 2;
  const worldY = tileY * TILE_SIZE + TILE_SIZE;

  // place the sprite’s origin at bottom-center of the tile
  sprite.setPosition(worldX, worldY);

  if (sprite.body && typeof sprite.body.reset === 'function') {
    // reset the body so its top-left is at the tile’s top-left
    sprite.body.reset(worldX - sprite.body.width / 2, worldY - sprite.body.height);
  }
  if (sprite.playerLabel) {
    // Place label under the sprite, relative to the new label origin
    sprite.playerLabel.setPosition(worldX, worldY - sprite.displayHeight - 4);
  }
}

/**
 * Configure camera bounds/follow behavior for centered or large rooms.
 * Uses a deadzone to reduce camera jitter while following the player.
 */
function adjustCameraCentering(scene) {
  const cam = scene.cameras.main;
  const { offsetX, offsetY, centered } = getWorldOffset(scene);
  const room = getCurrentRoom();
  const worldWidth = room.width * TILE_SIZE;
  const worldHeight = room.height * TILE_SIZE;

  if (centered) {
    // Expand bounds so camera can follow within a centered viewport
    cam.setBounds(-offsetX, -offsetY, worldWidth + offsetX * 2, worldHeight + offsetY * 2);
    const player = players[playerId];
    if (!player) return;
    cam.startFollow(player, false, 0.1, 0.1);
    cam.setDeadzone(cam.width / 4, cam.height / 4);
    return;
  }

  // Standard follow mode for larger rooms
  cam.setBounds(0, 0, worldWidth, worldHeight);
  const player = players[playerId];
  if (!player) return;
  cam.startFollow(player, false, 0.1, 0.1);
  cam.setDeadzone(cam.width / 4, cam.height / 4);
}

/**
 * Redraw the current room:
 * - Clears prior layers/colliders, lays down background/tiles/overlays.
 * - Applies tile physics properties and builds static colliders for 'void'.
 * - Highlights exits and refreshes edit grid; ensures local collisions.
 */
function drawRoom(scene) {
  if (gridGraphics) gridGraphics.destroy();
  // Reset previous void collisions
  if (voidLayer) {
    voidLayer.clear(true, true);
  } else {
    voidLayer = scene.physics.add.staticGroup();
  }
  // Remove previous tile images layer to avoid leftovers when room size changes
  if (scene.tileLayer) {
    scene.tileLayer.destroy();
    scene.tileLayer = null;
  }
  const room = getCurrentRoom();
  if (!room) return;

  // Now world bounds exactly match [0 … width*TILE_SIZE] × [0 … height*TILE_SIZE]
  scene.physics.world.setBounds(0, 0, room.width * TILE_SIZE, room.height * TILE_SIZE);

  gridGraphics = scene.add.graphics({ lineStyle: { width: 0, color: 0x555555 } });
  const { offsetX, offsetY } = getWorldOffset(scene);
  const cam = scene.cameras.main;

  // Highlight teleport exits with pulsing rectangles
  if (scene.exitHighlights) {
    scene.exitHighlights.forEach((r) => r.destroy());
  }
  scene.exitHighlights = [];
  (room.exits || []).forEach((exit) => {
    const { x, y } = exit.from;
    const rect = scene.add
      .rectangle(x * TILE_SIZE + TILE_SIZE / 2, y * TILE_SIZE + TILE_SIZE / 2, TILE_SIZE, TILE_SIZE)
      .setOrigin(0.5)
      .setStrokeStyle(1, 0xfefefe, 0.5)
      .setScrollFactor(1)
      .setDepth(0);
    scene.tweens.add({
      targets: rect,
      scaleX: 1.2,
      scaleY: 1.2,
      duration: 1000,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });
    scene.exitHighlights.push(rect);
  });

  const tileLayer = scene.add.layer().setDepth(-1);
  scene.tileLayer = tileLayer;

  if (room.background) {
    const roomWidthInPixels = room.width * TILE_SIZE;
    const roomHeightInPixels = room.height * TILE_SIZE;
    const bg = scene.add.image(0, 0, room.background).setOrigin(0).setDepth(-10).setScrollFactor(1);
    bg.setDisplaySize(roomWidthInPixels, roomHeightInPixels);
    bg.setCrop(0, 0, roomWidthInPixels, roomHeightInPixels);
  }

  if (room.tiles && Array.isArray(room.tiles)) {
    for (let y = 0; y < room.tiles.length; y++) {
      const row = room.tiles[y];
      for (let x = 0; x < row.length; x++) {
        const tile = row[x];
        if (!tile) continue;

        // Draw base terrain image or animation
        const baseKey = tile.icon ? tile.icon : tile.terrain;
        if (tile.icon) {
          scene.load.image(tile.icon, tile.icon);
        }
        // Support animation for base tile if tile.animation is present
        if (tile.animation && animations[tile.animation]) {
          const baseImg = scene.add.image(
            x * TILE_SIZE + TILE_SIZE / 2,
            y * TILE_SIZE + TILE_SIZE / 2,
            animations[tile.animation].frames[0]
          );
          baseImg.setDisplaySize(TILE_SIZE, TILE_SIZE);
          tileLayer.add(baseImg);
        } else {
          const baseImg = scene.add.image(
            x * TILE_SIZE + TILE_SIZE / 2,
            y * TILE_SIZE + TILE_SIZE / 2,
            baseKey
          );
          baseImg.setDisplaySize(TILE_SIZE, TILE_SIZE);
          tileLayer.add(baseImg);
        }

        // Draw overlay “layers” if any (support animation in layers too)
        if (tile.layers && Array.isArray(tile.layers)) {
          tile.layers
            .sort(
              (a, b) =>
                (a.zIndex ?? assets[a.key]?.defaultZ ?? 0) -
                (b.zIndex ?? assets[b.key]?.defaultZ ?? 0)
            )
            .forEach((layer) => {
              const def = assets[layer.key];
              // If this layer has an animation property, draw animation frame
              if (layer.animation && animations[layer.animation]) {
                const overlay = scene.add.image(
                  x * TILE_SIZE + TILE_SIZE / 2,
                  y * TILE_SIZE + TILE_SIZE / 2,
                  animations[layer.animation].frames[0]
                );
                overlay.setDisplaySize(TILE_SIZE, TILE_SIZE);
                overlay.setAlpha(layer.alpha ?? def?.defaultAlpha ?? 1);
                overlay.setDepth(layer.zIndex ?? def?.defaultZ ?? 0);
                tileLayer.add(overlay);
              } else {
                const overlay = scene.add.image(
                  x * TILE_SIZE + TILE_SIZE / 2,
                  y * TILE_SIZE + TILE_SIZE / 2,
                  layer.key
                );
                overlay.setDisplaySize(TILE_SIZE, TILE_SIZE);
                overlay.setAlpha(layer.alpha ?? def?.defaultAlpha ?? 1);
                overlay.setDepth(layer.zIndex ?? def?.defaultZ ?? 0);
                tileLayer.add(overlay);
              }
            });
        }

        // --- PHYSICS RULES APPLICATION ---
        // If tile has a properties object, check for physicsRule and apply
        if (tile.properties) {
          // Build the finalPhysics object
          let finalPhysics = {};
          // Apply physics rule if specified
          if (tile.properties.physicsRule && physicsRules[tile.properties.physicsRule]) {
            Object.assign(finalPhysics, physicsRules[tile.properties.physicsRule]);
          }
          // Apply overrides if specified (all other keys except physicsRule)
          for (const [key, value] of Object.entries(tile.properties)) {
            if (key !== 'physicsRule') {
              finalPhysics[key] = value;
            }
          }
          // Apply finalPhysics to the tile's physics body if needed
          // Example: set friction for this tile if a physics body exists
          // (In this implementation, you may want to use this info elsewhere, e.g. in movement logic)
          // Optionally, you could store finalPhysics on the tile for easy lookup
          tile._finalPhysics = finalPhysics;
        }
      }
    }
  }

  // Create static bodies for void tiles
  for (let y = 0; y < room.tiles.length; y++) {
    for (let x = 0; x < room.tiles[y].length; x++) {
      if (room.tiles[y][x].terrain === 'void') {
        // invisible rectangle as collider
        const block = scene.add
          .rectangle(x * TILE_SIZE, y * TILE_SIZE, TILE_SIZE, TILE_SIZE)
          .setOrigin(0)
          .setVisible(false);
        scene.physics.add.existing(block, true);
        voidLayer.add(block);
      }
    }
  }

  // Room name label and background (removed)

  // Ensure local player collides with void terrain
  const localSprite = players[playerId];
  if (localSprite && localSprite.body) {
    scene.physics.add.collider(localSprite, voidLayer);
  }

  updateEditGrid(scene);
}

/**
 * Ensure assets/scene are ready, then create a player sprite + label.
 * Remote players are immovable colliders; local player is dynamic.
 * @param {number} id
 * @param {{x:number,y:number,roomId:number,name?:string,privilege?:number}} pos
 */
function safeAddPlayer(id, pos) {
  if (!sceneReady || !preloadDone) {
    pendingPlayers.push({ id, pos });
    return;
  }
  if (players[id]) return;
  if (!currentScene.textures.exists('player')) {
    pendingPlayers.push({ id, pos });
    return;
  }

  const room = getCurrentRoom();
  let tileX, tileY;
  if (pos && typeof pos.x === 'number' && typeof pos.y === 'number') {
    tileX = Math.floor(pos.x / TILE_SIZE);
    tileY = Math.floor(pos.y / TILE_SIZE);
    // Use pos.roomId rather than legacy roomX/roomY
    if (id === playerId && typeof pos.roomId === 'number') {
      zone.currentRoomY = pos.roomId;
    }
  } else {
    tileX = Math.floor(room.width / 2);
    tileY = Math.floor(room.height / 2);
  }
  playerTiles[id] = {
    tileX,
    tileY,
    roomId: pos.roomId !== undefined ? pos.roomId : zone.currentRoomY,
    name: pos.name || id.toString(),
    privilege: pos.privilege,
  };

  const sprite = currentScene.physics.add.sprite(0, 0, 'player');
  // Use bottom-center origin so sprite sits snug in tile
  sprite.setOrigin(0);
  sprite.body.setSize(TILE_SIZE, TILE_SIZE, true);
  sprite.setCollideWorldBounds(true);
  // Ensure sprite physics is movable and responds to velocity
  sprite.body.setAllowGravity(false);
  sprite.body.setMaxVelocity(100, 100);
  sprite.body.setImmovable(false);
  sprite.body.moves = true;
  sprite.body.enable = true; // Explicitly enable body
  sprite.body.setVelocity(0, 0); // Reset velocity to prevent sleeping
  // Ensure collision box matches a single tile (32×32) and is aligned to sprite origin
  //  sprite.body.setSize(TILE_SIZE, TILE_SIZE);
  sprite.body.setOffset(0, 0); // negative value here for first arg moves to the right.
  const label = currentScene.add
    .text(0, 0, pos.name || id.toString(), {
      fontFamily: gameFont,
      fontSize: '12px',
      color: '#ffffff',
    })
    .setOrigin(0, 0);
  sprite.playerLabel = label;
  positionSprite(sprite, tileX, tileY, currentScene);

  players[id] = sprite;
  // --- Player-vs-player collision setup ---
  if (playerId !== null) {
    const localSprite = players[playerId];
    // Remote sprite: make immovable and collide with local
    if (id !== playerId) {
      sprite.body.setImmovable(true);
      sprite.body.moves = false;
      if (localSprite) {
        currentScene.physics.add.collider(localSprite, sprite);
      }
    }
    // Local sprite: collide with all existing remotes
    else {
      for (const [otherId, otherSprite] of Object.entries(players)) {
        if (otherId !== id.toString()) {
          otherSprite.body.setImmovable(true);
          otherSprite.body.moves = false;
          currentScene.physics.add.collider(sprite, otherSprite);
        }
      }
    }
  }
  const pdata = playerTiles[id];
  if (pdata.roomId === zone.currentRoomY) {
    sprite.setVisible(true);
  } else {
    sprite.setVisible(false);
    sprite.playerLabel.setVisible(false);
  }

  if (id === playerId) {
    localSpriteReady = true;
    currentScene.time.delayedCall(0, () => {
      currentScene.cameras.main.setZoom(zoomLevel);
      drawRoom(currentScene);
      adjustCameraCentering(currentScene);
      lastRoomX = zone.currentRoomX;
      lastRoomY = zone.currentRoomY;
    });
  }
}

/** Spawn initial player set after scene+assets+init payload are ready. */
function tryStart() {
  if (sceneReady && preloadDone && initData) {
    for (let [id, pos] of Object.entries(initData.players)) {
      safeAddPlayer(parseInt(id), pos);
    }
    while (pendingPlayers.length) {
      const { id, pos } = pendingPlayers.shift();
      safeAddPlayer(id, pos);
    }
    initData = null;
  }
  updateConsoleLayout();
}

ws.onmessage = (event) => {
  // --- Server → Client message router (typed envelopes via `msg.type`) ---
  const zid = zone.currentRoomX;
  const zname = zone.defs[zid]?.name;

  const msg = JSON.parse(event.data);
  if (msg.type === 'init') {
    // Seed world state, local id, and schedule deferred spawns/UI refresh.
    log('Received startup data...configuring world.');
    playerId = msg.id;
    initData = msg;
    if (sceneReady && preloadDone) {
      drawRoom(currentScene);
      adjustCameraCentering(currentScene);
      tryStart();
      playRoomAmbience(getCurrentRoom());
      // Now the Phaser scene is ready — spawn any NPCs we buffered
      if (pendingNPCs.length) {
        clearNPCs();
        pendingNPCs.forEach((npc) => addNPC(npc));
        pendingNPCs = [];
      }
    }
  } else if (msg.type === 'join') {
    log('New player connection');
    safeAddPlayer(msg.id, msg.pos);
  } else if (msg.type === 'update') {
    // Reconcile remote position/name/room and tween visible movement.
    // Parse updated fields from top-level message
    const targetX = msg.x;
    const targetY = msg.y;
    const name = msg.name;
    const roomId = msg.roomId;

    // Ensure we have a player sprite
    if (!players[msg.id]) {
      // Safe-add player using new signature: pass roomId as pos.roomId
      safeAddPlayer(msg.id, { x: targetX, y: targetY, name, roomId, privilege: msg.privilege });
    }
    const remoteSprite = players[msg.id];
    if (remoteSprite) {
      if (msg.id !== playerId) {
        // movement tween for others
        const dx = targetX - remoteSprite.x;
        const dy = targetY - remoteSprite.y;
        currentScene.tweens.killTweensOf(remoteSprite);
        if (remoteSprite.playerLabel) currentScene.tweens.killTweensOf(remoteSprite.playerLabel);
        if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
          const direction = playMovementAnimation(remoteSprite, dx, dy);
          remoteSprite.lastDirection = direction;
        }
        remoteSprite.anims.play(`walk-${remoteSprite.lastDirection}`, true);
        currentScene.tweens.add({
          targets: remoteSprite,
          x: targetX,
          y: targetY,
          duration: 320,
          ease: 'Linear',
          onStart: () => {
            remoteSprite.anims.play(`walk-${remoteSprite.lastDirection}`, true);
          },
          onComplete: () => {
            const idleDir = `idle-${remoteSprite.lastDirection || 'down'}`;
            if (remoteSprite.anims.animationManager.exists(idleDir)) {
              remoteSprite.anims.play(idleDir, true);
            }
          },
        });
        if (remoteSprite.playerLabel) {
          currentScene.tweens.add({
            targets: remoteSprite.playerLabel,
            x: targetX,
            y: targetY - TILE_SIZE / 2 - 5,
            duration: 320,
            ease: 'Linear',
          });
        }
      }
      // Update name label (just name, no tile coords)
      if (remoteSprite.playerLabel && name) {
        remoteSprite.playerLabel.setText(name);
      }
      // Update in-memory position and room
      if (!playerTiles[msg.id]) playerTiles[msg.id] = {};
      playerTiles[msg.id].x = targetX;
      playerTiles[msg.id].y = targetY;
      playerTiles[msg.id].roomId = roomId;
      playerTiles[msg.id].privilege = msg.privilege;
      playerTiles[msg.id].name = name || msg.id.toString();
    }
  }
  // --- Handle player leave/disconnect ---
  else if (msg.type === 'leave') {
    // Animate a graceful departure and clean in-memory maps.
    const departedId = msg.id;
    const sprite = players[departedId];
    const label = sprite?.playerLabel;
    if (sprite) {
      // Play fade & pop animation on sprite and label
      currentScene.tweens.add({
        targets: [sprite, label].filter(Boolean),
        alpha: 0,
        scale: 0,
        duration: 500,
        ease: 'Back.easeIn',
        onComplete: () => {
          if (label) label.destroy();
          sprite.destroy();
          delete players[departedId];
          delete playerTiles[departedId];
          const name = playerTiles[departedId]?.name || departedId;
          log(`${name} has disconnected.`);
        },
      });
    }
  } else if (msg.type === 'room-updated') {
    // Apply patch (terrain or tileExits) and redraw if viewing this room.
    const { roomId, patch } = msg;
    const zid = zone.currentRoomX;
    const roomKey = `${zid},${roomId}`;
    const room = zone.rooms[roomKey];
    if (room && room.tiles && room.tiles[patch.y] && room.tiles[patch.y][patch.x]) {
      const tile = room.tiles[patch.y][patch.x];
      // Apply terrain update if present
      if (patch.terrain !== undefined) {
        tile.terrain = patch.terrain;
      }
      // Apply exits update if present
      if (patch.tileExits !== undefined) {
        if (patch.tileExits === null) {
          delete tile.tileExits;
        } else {
          tile.tileExits = patch.tileExits;
        }
      }
      // Redraw if currently viewing this room
      if (zone.currentRoomY === roomId) {
        drawRoom(currentScene);
        adjustCameraCentering(currentScene);
      }
    }
  } else if (msg.type === 'error') {
    errorDiv.textContent = msg.message || 'Login error.';
    errorDiv.style.display = 'block';

    if (!document.body.contains(nameForm)) {
      document.body.appendChild(nameForm);
    }

    nameForm.style.display = 'flex';
    passwordInput.value = '';
    passwordInput.focus();
  } else if (msg.type === 'time-update') {
    // Refresh on-screen location/time HUD elements.
    const locationInfo = document.getElementById('location-info');
    const timeInfo = document.getElementById('time-info');
    if (locationInfo) {
      const room = getCurrentRoom();
      //            locationInfo.innerHTML = `<b><span style="font-size:1.2em;">${room.name}</span></b><br>(${zone.defs[zone.currentRoomX]?.name || zone.currentRoomX})`;
      locationInfo.innerHTML = `<b><span style="font-size:1.2em;">${room.name}</span></b>`;
    }
    if (timeInfo) {
      const { day, hour, year, season } = msg;
      timeInfo.innerHTML = `<span style="font-size:.8em;">${season} Year ${year}, day ${day}.<br>${hour}</span>`;
    }
  }
  // --- Object rendering protocol ---
  else if (msg.type === 'init-inventory') {
    // Replace local inventory with server-authoritative snapshot.
    myInventory = msg.inventory.slice();
    // Refresh UI if overlay open
    if (uiRefs.charInfoEl) updateInventoryUI();
  } else if (msg.type === 'init-objects') {
    // Wipe & paint objects for the current room.
    clearObjects();
    msg.objects.forEach((inst) => addObject(inst));
  } else if (msg.type === 'init-npcs') {
    // Wipe & spawn NPCs now or buffer until scene is fully ready.
    if (!sceneReady || !preloadDone || !currentScene) {
      pendingNPCs = msg.npcs.slice();
    }
    // ...otherwise clear & spawn immediately
    else {
      clearNPCs();
      msg.npcs.forEach((npc) => addNPC(npc));
    }
  } else if (msg.type === 'object-picked') {
    // Remove picked instance from map; if ours, add to inventory.
    // Use full instance from server, or fallback to pending pickup
    let inst = msg.instance;
    if (!inst && msg.instanceId) {
      inst = pendingPickupInstances[msg.instanceId];
      if (inst) delete pendingPickupInstances[msg.instanceId];
    }
    if (!inst) {
      console.error(`No instance data for picked object ${msg.instanceId}`);
      return;
    }
    // Remove the sprite in all cases
    // If this event is for us, add to inventory and refresh UI
    if (msg.playerId === playerId) {
      myInventory.push(inst);
      if (uiRefs.charInfoEl) updateInventoryUI();
    }
    removeObject(inst.instanceId);
  } else if (msg.type === 'object-dropped') {
    // Remove from inventory; render instance if it’s in-view room.
    const inst = msg.instance;
    // Remove dropped instance from our inventory
    myInventory = myInventory.filter((i) => i.instanceId !== inst.instanceId);
    // Refresh inventory display if open
    if (uiRefs.charInfoEl) updateInventoryUI();
    // Render dropped object on map if it's in our current room
    if (
      inst.zone.toString() === zone.currentRoomX.toString() &&
      inst.roomId === zone.currentRoomY
    ) {
      addObject(inst);
    }
  } else if (msg.type === 'object-spawned') {
    // Render new instance if spawn occurred in our current room.
    const inst = msg.instance;
    if (
      inst.zone.toString() === zone.currentRoomX.toString() &&
      inst.roomId === zone.currentRoomY
    ) {
      addObject(inst);
    }
  } else if (msg.type === 'npc-start-path') {
    // Animate an NPC along a server-provided path (tile waypoints → pixels).
    /*console.log('Received npc-start-path message:', msg);
      console.log('Current npcSprites keys before path start:', Object.keys(npcSprites));*/
    const { instanceId, path, segmentDuration } = msg;
    const sprite = npcSprites[instanceId];
    /*console.log(`Sprite for instance ${instanceId}:`, sprite);*/
    if (!sprite) return; // not in this room or not yet spawned

    // Convert tile path to pixel waypoints
    const waypoints = path.map(([tx, ty]) => ({
      x: tx * TILE_SIZE + TILE_SIZE / 2,
      y: ty * TILE_SIZE + TILE_SIZE / 2,
    }));

    // Build and play a tween timeline for smooth, per-tile movement
    const timeline = currentScene.tweens.createTimeline();
    waypoints.forEach((pt, idx) => {
      //console.log(`Starting tween segment ${idx+1}/${waypoints.length} to`, pt);
      timeline.add({
        targets: sprite,
        x: pt.x,
        y: pt.y,
        duration: segmentDuration,
        offset: idx * segmentDuration,
        ease: 'Linear',
        onStart: () => {
          // determine direction and play walk animation
          const dx = pt.x - sprite.x;
          const dy = pt.y - sprite.y;
          playMovementAnimation(sprite, dx, dy);
        },
        onComplete: () => {
          // when the last segment finishes, switch back to idle
          if (idx === waypoints.length - 1) {
            const idleKey = `${sprite.texture.key}-idle-${sprite.lastDirection || 'down'}`;
            if (sprite.anims && sprite.anims.animationManager.exists(idleKey)) {
              sprite.anims.play(idleKey, true);
            }
          }
        },
      });
    });
    timeline.play();
  } else if (msg.type === 'notification') {
    log(`oh no. ${msg}`);
  } else if (msg.type === 'npc-move') {
    // Snap sprite to final authoritative tile after animation completes.
    // Final authoritative update after path completion: snap to exact tile
    const npc = msg.npc;
    const sprite = npcSprites[npc.instanceId];
    if (sprite) {
      const x = npc.x * TILE_SIZE + TILE_SIZE / 2;
      const y = npc.y * TILE_SIZE + TILE_SIZE / 2;
      sprite.setPosition(x, y);
    }
  } else if (msg.type === 'emote') {
    // Bubble a short message above a player/NPC.
    // Display a transient emote bubble for any sprite
    showEmote(msg.instanceId, msg.text);
  } else if (msg.type === 'play-audio') {
    // Play a keyed audio resource (loop or one-shot) with optional options.
    // Play a server-triggered audio cue
    const key = msg.key;
    const options = msg.options || {};
    if (currentScene && currentScene.sound) {
      currentScene.sound.play(key, options);
    }
  }
  // --- Handle get-context-menu protocol ---
  else if (msg.type === 'context-menu') {
    // Render additional server-driven NPC menu options.
    console.log(`CONTEXT MENU: ${JSON.stringify(msg)}`);
    const menu = msg.options;
    if (typeof renderContextMenu === 'function') {
      renderContextMenu(menu, msg.instanceId);
    } else {
      console.warn('renderContextMenu function is not defined');
    }
  }
  // --- Handle context-action protocol ---
  else if (msg.type === 'context-action') {
    // Perform a client-side context action, if supported by this build.
    if (typeof performContextAction === 'function') {
      performContextAction(msg.action);
    } else {
      console.warn('performContextAction function is not defined');
    }
  }
};

/**
 * Initialize Phaser with arcade physics and responsive scaling.
 * Defers removal of loading overlay until config is constructed.
 */
function startGame() {
  const gameDiv = document.getElementById('game');
  if (gameDiv) gameDiv.style.visibility = 'hidden';

  const config = {
    type: Phaser.AUTO,
    width: window.innerWidth,
    height: window.innerHeight,
    parent: 'game',
    pixelArt: true, // disables texture filtering, including text
    roundPixels: true, // rounds sprite positions to whole-pixels
    /*        antialias: false,
        pixelArt: true,
        roundPixels: false, */
    scene: { preload, create, update },
    physics: {
      default: 'arcade',
      arcade: {
        debug: _debug,
        debugShowBody: _debug,
        debugBodyColor: 0xff0000,
      },
    },
  };
  const game = new Phaser.Game(config);

  window.addEventListener('resize', () => {
    game.scale.resize(window.innerWidth, window.innerHeight);
    updateConsoleLayout();
  });

  loadingOverlay.remove();
}

document.body.style.fontFamily = gameFont;

loadWorldData().then(() => {
  // Retrieve object type definitions (including sprite keys)
  fetch('/api/objects')
    .then((r) => r.json())
    .then((list) => {
      list.forEach((o) => {
        objectTypes[o.id] = o;
      });
    })
    .then(startGame);
});

/**
 * Phase 1: load `assets.json` → then load images/spritesheets/audio it lists.
 * Creates common player/NPC animations once assets are available.
 */
function preload() {
  this.load.json('assets', 'assets.json');
  this.load.once('complete', () => {
    assets = this.cache.json.get('assets');
    // Load player sprite sheet instead of static image
    this.load.spritesheet('player', 'assets/images/player_sheet.png', {
      frameWidth: 32,
      frameHeight: 32,
    });
    for (const [key, def] of Object.entries(assets)) {
      if (def.spriteSheet) {
        this.load.spritesheet(key, def.spriteSheet, {
          frameWidth: 32,
          frameHeight: 32,
        });
      } else {
        this.load.image(key, def.src);
      }
    }
    // load every audio key
    if (assets.audio) {
      for (const [key, paths] of Object.entries(assets.audio)) {
        // paths should be an array: [ 'file.ogg', 'file.mp3' ]
        this.load.audio(key, paths);
      }
    }
    this.load.once('complete', () => {
      this.anims.create({ key: 'idle-down', frames: [{ key: 'player', frame: 0 }], frameRate: 1 });
      this.anims.create({
        key: 'walk-down',
        frames: this.anims.generateFrameNumbers('player', { start: 0, end: 2 }),
        frameRate: 6,
        repeat: -1,
      });
      this.anims.create({ key: 'idle-left', frames: [{ key: 'player', frame: 3 }], frameRate: 1 });
      this.anims.create({
        key: 'walk-left',
        frames: this.anims.generateFrameNumbers('player', { start: 3, end: 5 }),
        frameRate: 6,
        repeat: -1,
      });
      this.anims.create({ key: 'idle-right', frames: [{ key: 'player', frame: 6 }], frameRate: 1 });
      this.anims.create({
        key: 'walk-right',
        frames: this.anims.generateFrameNumbers('player', { start: 6, end: 8 }),
        frameRate: 6,
        repeat: -1,
      });
      this.anims.create({ key: 'idle-up', frames: [{ key: 'player', frame: 9 }], frameRate: 1 });
      this.anims.create({
        key: 'walk-up',
        frames: this.anims.generateFrameNumbers('player', { start: 9, end: 11 }),
        frameRate: 6,
        repeat: -1,
      });
      // NPC animations: one 3-frame walk + 1-frame idle per direction
      for (const [key, def] of Object.entries(assets)) {
        if (!def.spriteSheet) continue;
        // down
        this.anims.create({ key: `${key}-idle-down`, frames: [{ key, frame: 0 }], frameRate: 1 });
        this.anims.create({
          key: `${key}-walk-down`,
          frames: this.anims.generateFrameNumbers(key, { start: 0, end: 2 }),
          frameRate: 6,
          repeat: -1,
        });
        // left
        this.anims.create({ key: `${key}-idle-left`, frames: [{ key, frame: 3 }], frameRate: 1 });
        this.anims.create({
          key: `${key}-walk-left`,
          frames: this.anims.generateFrameNumbers(key, { start: 3, end: 5 }),
          frameRate: 6,
          repeat: -1,
        });
        // right
        this.anims.create({ key: `${key}-idle-right`, frames: [{ key, frame: 6 }], frameRate: 1 });
        this.anims.create({
          key: `${key}-walk-right`,
          frames: this.anims.generateFrameNumbers(key, { start: 6, end: 8 }),
          frameRate: 6,
          repeat: -1,
        });
        // up
        this.anims.create({ key: `${key}-idle-up`, frames: [{ key, frame: 9 }], frameRate: 1 });
        this.anims.create({
          key: `${key}-walk-up`,
          frames: this.anims.generateFrameNumbers(key, { start: 9, end: 11 }),
          frameRate: 6,
          repeat: -1,
        });
      }
      preloadDone = true;
      if (sceneReady && preloadDone && initData) tryStart();
    });
    this.load.start(); // start terrain image loading
  });

  this.load.start(); // start asset json loading
}

/**
 * Scene create: input binding, camera zoom handling, edit-mode hooks,
 * physics world bounds, and late NPC flush if any were buffered.
 */
function create() {
  cursors = this.input.keyboard.createCursorKeys();
  this.zoomKeys = this.input.keyboard.addKeys({
    plus1: Phaser.Input.Keyboard.KeyCodes.Z, // main keyboard =/+ key
    plus2: Phaser.Input.Keyboard.KeyCodes.NUMPAD_ADD,
    minus1: Phaser.Input.Keyboard.KeyCodes.X, // main keyboard -/_ key
    minus2: Phaser.Input.Keyboard.KeyCodes.NUMPAD_SUBTRACT,
  });
  currentScene = this;

  if (_debug) {
    debugBodyGraphics = this.add.graphics();
    debugBodyGraphics.setDepth(1001);
    debugBodyGraphics.setScrollFactor(1);
  }

  sceneReady = true;
  // Set physics world bounds to match the visible camera area
  this.physics.world.setBounds(0, 0, this.cameras.main.width, this.cameras.main.height);
  //    this.physics.world.createDebugGraphic();

  if (sceneReady && preloadDone && initData) tryStart();

  this.cameras.main.setZoom(zoomLevel);

  this.scale.on('resize', (gameSize) => {
    if (!zone.rooms || !Object.keys(zone.rooms).length) return;
    drawRoom(this);
    adjustCameraCentering(this);
    this.time.delayedCall(0, () => {
      for (const [id, sprite] of Object.entries(players)) {
        const pd = playerTiles[id];
        // Use roomId for visibility logic
        if (pd.roomId === zone.currentRoomY) {
          if (id !== playerId && !movementInProgress) {
            positionSprite(sprite, pd.tileX, pd.tileY, this);
          }
          sprite.setVisible(true);
          if (sprite.playerLabel) sprite.playerLabel.setVisible(true);
        } else {
          sprite.setVisible(false);
          if (sprite.playerLabel) sprite.playerLabel.setVisible(false);
        }
      }
    });
  });

  // Ensure Phaser game canvas receives keyboard focus for keyboard input
  this.input.keyboard.enabled = true;
  this.input.keyboard.target = this.game.canvas;
  this.game.canvas.setAttribute('tabindex', '0');
  this.game.canvas.focus();

  // --- Wizard Edit Mode Toggle (press E) ---
  this.input.keyboard.on('keydown-E', () => {
    if (playerTiles[playerId]?.privilege >= 10) {
      editMode = !editMode;
      updateEditGrid(currentScene);
      log(`Edit mode ${editMode ? 'ON' : 'OFF'}`);
    }
  });
  // Click-to-edit handler
  this.input.on('pointerdown', (pointer) => {
    if (!editMode) return;
    if (playerTiles[playerId]?.privilege < 10) return;
    const cam = this.cameras.main;
    const worldPoint = cam.getWorldPoint(pointer.x, pointer.y);
    const tx = Math.floor(worldPoint.x / TILE_SIZE);
    const ty = Math.floor(worldPoint.y / TILE_SIZE);
    // Show icon-based selector
    showTerrainSelector(tx, ty);
  });

  // After scene is fully ready, flush any buffered NPC spawns
  if (pendingNPCs.length) {
    clearNPCs();
    pendingNPCs.forEach((npc) => addNPC(npc));
    pendingNPCs = [];
  }
}

/**
 * Per-frame update:
 * - Visibility/collision toggling by room.
 * - Zoom controls & room redraws.
 * - Local movement with tile-aware collision and friction.
 * - Tile SFX + emote bubble tracking.
 * - Broadcast local player position deltas to server.
 */
function update() {
  if (playerId === null || !localSpriteReady) return;
  // Don’t process movement or tile logic while fading between rooms
  if (transitionInProgress) return;

  // --- Player visibility and position update for all players ---
  for (const [id, s] of Object.entries(players)) {
    const pd = playerTiles[id];
    if (!pd) continue;

    const inRoom = pd.roomId === zone.currentRoomY;

    if (inRoom) {
      if (id !== playerId) {
        // Immediately place remote sprite at the latest position to avoid delayed tweening
        if (pd.x !== undefined && pd.y !== undefined) {
          s.setPosition(pd.x, pd.y);
        }
        if (s.playerLabel) {
          s.playerLabel.setPosition(s.x, s.y - TILE_SIZE / 2 - 5);
        }
      }
      s.setVisible(true);
      if (s.playerLabel) s.playerLabel.setVisible(true);
    } else {
      s.setVisible(false);
      if (s.playerLabel) s.playerLabel.setVisible(false);
    }
    // Disable collisions for sprites in other rooms
    if (s.body) {
      s.body.enable = inRoom;
    }
    // Debug border follows player sprite
    if (s.debugRect && _debug) {
      const b = s.body;
      s.debugRect.setPosition(b.x + b.width / 2, b.y + b.height / 2);
    }
  }

  const sprite = players[playerId];
  const tiles = playerTiles[playerId];
  if (!sprite || !tiles) return;

  if (this.zoomKeys.plus1.isDown || this.zoomKeys.plus2.isDown) {
    zoomLevel = Math.min(MAX_ZOOM, zoomLevel + 0.1);
    this.cameras.main.zoomTo(zoomLevel, 250, 'Sine.easeInOut');
    drawRoom(this);
    adjustCameraCentering(this);
  }

  if (this.zoomKeys.minus1.isDown || this.zoomKeys.minus2.isDown) {
    zoomLevel = Math.max(MIN_ZOOM, zoomLevel - 0.1);
    this.cameras.main.zoomTo(zoomLevel, 250, 'Sine.easeInOut');
    drawRoom(this);
    adjustCameraCentering(this);
  }

  // --- FLUID PHYSICS-BASED MOVEMENT ---
  if (!sprite.body) return;

  // Reset velocity
  sprite.body.setVelocity(0, 0);
  const speed = 100; // pixels per second
  let moving = false;

  // Determine movement direction (only one per frame)
  let inputDir = null;
  if (cursors.left.isDown) inputDir = 'left';
  else if (cursors.right.isDown) inputDir = 'right';
  else if (cursors.up.isDown) inputDir = 'up';
  else if (cursors.down.isDown) inputDir = 'down';

  if (inputDir) {
    lastDirection = inputDir;
    const room = getCurrentRoom();
    const currTileX = Math.min(
      room.width - 1,
      Math.max(0, Math.floor(sprite.body.center.x / TILE_SIZE))
    );
    const currTileY = Math.min(
      room.height - 1,
      Math.max(0, Math.floor(sprite.body.center.y / TILE_SIZE))
    );
    // Read tile properties for friction (if any), also consider physicsRule
    const tileDef = room.tiles[currTileY][currTileX] || {};
    // Use _finalPhysics if present, else fallback to properties
    let tileProps = tileDef._finalPhysics || tileDef.properties || {};

    let velocityX = 0,
      velocityY = 0,
      animKey = null;

    if (inputDir === 'left') {
      const targetX = currTileX - 1;
      if (targetX >= 0 && room.tiles[currTileY][targetX].terrain !== 'void') {
        velocityX = -speed;
        animKey = 'walk-left';
      }
    } else if (inputDir === 'right') {
      const targetX = currTileX + 1;
      if (targetX < room.width && room.tiles[currTileY][targetX].terrain !== 'void') {
        velocityX = speed;
        animKey = 'walk-right';
      }
    } else if (inputDir === 'up') {
      const targetY = currTileY - 1;
      if (targetY >= 0 && room.tiles[targetY][currTileX].terrain !== 'void') {
        velocityY = -speed;
        animKey = 'walk-up';
      }
    } else if (inputDir === 'down') {
      const targetY = currTileY + 1;
      if (targetY < room.height && room.tiles[targetY][currTileX].terrain !== 'void') {
        velocityY = speed;
        animKey = 'walk-down';
      }
    }

    // Apply friction multiplier if defined
    if (tileProps.friction !== undefined) {
      velocityX *= tileProps.friction;
      velocityY *= tileProps.friction;
    }

    if (velocityX !== 0 || velocityY !== 0) {
      sprite.body.setVelocity(velocityX, velocityY);
      sprite.anims.play(animKey, true);
      moving = true;
    }
  }
  if (!moving) {
    const idleKey = `idle-${lastDirection}`;
    if (sprite.anims.animationManager.exists(idleKey)) {
      sprite.anims.play(idleKey, true);
    }
  }

  // --- TILE SOUND LOGIC ---
  // After determining the current tile, check for a physicsRule and play sound if needed
  // (do this after movement, so the sound reflects the tile the player is on)
  {
    const room = getCurrentRoom();
    const currTileX = Math.min(
      room.width - 1,
      Math.max(0, Math.floor(sprite.body.center.x / TILE_SIZE))
    );
    const currTileY = Math.min(
      room.height - 1,
      Math.max(0, Math.floor(sprite.body.center.y / TILE_SIZE))
    );
    const tile = room.tiles[currTileY]?.[currTileX];
    // physicsRules is loaded from properties.json at startup
    const ruleName = tile?.properties?.physicsRule;
    const rule = ruleName ? physicsRules[ruleName] : null;
    const soundConfig = rule?.sound;
    if (soundConfig) {
      const { resource, type } = soundConfig;
      if (type === 'loop') {
        if (!currentSound || currentSound.key !== resource) {
          if (currentSound) currentSound.stop();
          currentSound = this.sound.add(resource, { loop: true });
          currentSound.play();
        }
      } else if (type === 'oneshot') {
        this.sound.play(resource);
      }
    } else {
      if (currentSound) {
        currentSound.stop();
        currentSound = null;
      }
    }
  }

  // Update player label position during physics-based movement
  if (sprite.playerLabel) {
    sprite.playerLabel.setPosition(sprite.x, sprite.y - TILE_SIZE / 2 - 5);
    // Update label text with just the name
    const localName = playerTiles[playerId].name;
    sprite.playerLabel.setText(localName);
  }

  // --- TILE-AWARENESS & ROOM TRANSITION LOGIC ---
  // Use the physics body center for accurate tile detection, clamped to room bounds
  const room = getCurrentRoom();
  const currTileX = Math.min(
    room.width - 1,
    Math.max(0, Math.floor(sprite.body.center.x / TILE_SIZE))
  );
  const currTileY = Math.min(
    room.height - 1,
    Math.max(0, Math.floor(sprite.body.center.y / TILE_SIZE))
  );
  // Only trigger a direct exit once upon first arrival on the exit tile
  const prevTileX = tiles.tileX;
  const prevTileY = tiles.tileY;
  // Treat initial spawn (undefined prevTileX) as "just arrived"
  const justArrivedOnTile =
    prevTileX === undefined || currTileX !== prevTileX || currTileY !== prevTileY;

  // Unified room-transition logic
  const tile = room.tiles[currTileY]?.[currTileX];
  const exitDef = tile?.tileExits?.[lastDirection];
  if (
    exitDef &&
    !transitionInProgress &&
    (justArrivedOnTile || sprite.body.blocked[lastDirection] || !moving)
  ) {
    transitionInProgress = true;
    // Switch to the new room by its ID; zone ID stays the same
    const newRoomId = exitDef.roomId;
    zone.currentRoomY = newRoomId;
    tiles.roomId = newRoomId;
    tiles.tileX = exitDef.x;
    tiles.tileY = exitDef.y;
    const cam = currentScene.cameras.main;
    const newX = tiles.tileX * TILE_SIZE + TILE_SIZE / 2;
    const newY = tiles.tileY * TILE_SIZE + TILE_SIZE / 2;
    cam.fadeOut(100);
    cam.once('camerafadeoutcomplete', () => {
      // Clear any active emote bubbles at start of transition
      Object.values(emoteBubbles).forEach((b) => b.destroy());
      Object.keys(emoteBubbles).forEach((id) => delete emoteBubbles[id]);
      drawRoom(currentScene);
      adjustCameraCentering(currentScene);
      sprite.body.reset(newX, newY);
      cam.fadeIn(100);
      cam.once('camerafadeincomplete', () => {
        transitionInProgress = false;
        playRoomAmbience(getCurrentRoom());
        // Update room info panel after room transition
        const locationInfo = document.getElementById('location-info');
        if (locationInfo) {
          const room = getCurrentRoom();
          locationInfo.innerHTML = `<b><span style="font-size:1.2em;">${room.name}</span></b>`;
        }
        // Clear old objects and request new ones after room transition
        clearObjects();
        clearNPCs();
        ws.send(
          JSON.stringify({
            type: 'request-objects-and-npcs',
            zone: zone.currentRoomX,
            roomId: zone.currentRoomY,
          })
        );
      });
    });
    return;
  }

  // Teleport-exit logic: handle room.exits array
  const teleport = room.exits?.find((e) => e.from.x === currTileX && e.from.y === currTileY);
  if (teleport && !transitionInProgress) {
    transitionInProgress = true;
    const { to } = teleport;
    // Apply teleport destination
    zone.currentRoomY = to.roomId;
    tiles.roomId = to.roomId;
    tiles.tileX = to.x;
    tiles.tileY = to.y;
    const cam = currentScene.cameras.main;
    const newX = to.x * TILE_SIZE + TILE_SIZE / 2;
    const newY = to.y * TILE_SIZE + TILE_SIZE / 2;
    cam.fadeOut(100);
    cam.once('camerafadeoutcomplete', () => {
      // Clear any active emote bubbles at start of transition
      Object.values(emoteBubbles).forEach((b) => b.destroy());
      Object.keys(emoteBubbles).forEach((id) => delete emoteBubbles[id]);
      drawRoom(currentScene);
      adjustCameraCentering(currentScene);
      sprite.body.reset(newX, newY);
      log(`You teleport to ${getCurrentRoom().name}.`);
      cam.fadeIn(100);
      cam.once('camerafadeincomplete', () => {
        transitionInProgress = false;
        playRoomAmbience(getCurrentRoom());
        // Update room info panel after teleport
        const locationInfo = document.getElementById('location-info');
        if (locationInfo) {
          const room = getCurrentRoom();
          locationInfo.innerHTML = `Zone: ${zone.defs[zone.currentRoomX]?.name || zone.currentRoomX}<br>Room: ${room.name}`;
        }
        // Clear old objects and request new ones after teleport
        clearObjects();
        clearNPCs();
        ws.send(
          JSON.stringify({
            type: 'request-objects-and-npcs',
            zone: zone.currentRoomX,
            roomId: zone.currentRoomY,
          })
        );
      });
    });
    return;
  }

  // Update tileX/tileY only if inside bounds
  if (currTileX >= 0 && currTileX < room.width && currTileY >= 0 && currTileY < room.height) {
    if (currTileX !== tiles.tileX || currTileY !== tiles.tileY) {
      tiles.tileX = currTileX;
      tiles.tileY = currTileY;
    }
  }

  // --- Broadcast local player position to server every movement frame ---
  if (moving) {
    ws.send(
      JSON.stringify({
        type: 'update',
        id: playerId,
        name: playerTiles[playerId].name,
        x: sprite.x,
        y: sprite.y,
        roomId: zone.currentRoomY,
        privilege: playerTiles[playerId].privilege,
      })
    );
  }

  // (Phaser handles physics debug drawing via config.debug)

  // Reposition active emote bubbles to follow their sprites
  for (const [id, bubble] of Object.entries(emoteBubbles)) {
    const sprite = players[id] || npcSprites[id];
    if (sprite) {
      bubble.x = sprite.x + TILE_SIZE / 2;
      // Use stored bubbleOffset so pointer stays flush with sprite
      bubble.y = sprite.y - bubble.bubbleOffset;
    }
  }
}

// Toggle character info overlay on question mark
window.addEventListener('keydown', (e) => {
  if (e.key === '?') {
    if (uiRefs.charInfoEl) {
      removeCharInfoOverlay();
    } else createCharInfoOverlay();
  }
});

// --- Context menu protocol implementations ---
let currentContextMenu = null;

/** Remove any existing custom context menu from the DOM. */
function hideContextMenu() {
  if (currentContextMenu) {
    currentContextMenu.remove();
    currentContextMenu = null;
  }
}

/**
 * Render extra server-provided NPC options into an existing menu panel.
 * @param {{label:string,action:string}[]} menu
 * @param {string} instance - npc instance id
 */
function renderContextMenu(menu, instance) {
  const container = document.getElementById('npc-menu');
  if (!container) return;

  menu.forEach((item) => {
    const btn = document.createElement('div');
    btn.textContent = item.label;
    btn.style.color = 'white';
    btn.style.padding = '4px';
    btn.style.cursor = 'pointer';
    btn.onclick = () => {
      ws.send(
        JSON.stringify({
          type: 'context-action',
          action: item.action,
          targetType: 'npc',
          instanceId: instance,
        })
      );
      container.remove();
    };
    container.appendChild(btn);
  });
  //  document.body.appendChild(container);
  currentContextMenu = menu;
}

/**
 * Execute a simple local-only context action (if supported).
 * Server-authoritative actions are requested via WebSocket instead.
 */
function performContextAction(action, data) {
  if (action === 'inspect') {
  } else {
    console.warn('Unknown context action:', action);
  }
}

export {
  animations,
  assets,
  currentScene,
  drawRoom,
  editMode,
  gameFont,
  getCurrentRoom,
  log,
  myInventory,
  objectTypes,
  physicsRules,
  playerId,
  playerTiles,
  TILE_SIZE,
  ws,
  zone
};
export const uiRefs = {
  charInfoEl: document.getElementById('char-info'),
};
// Oof! EOF (client_main.js).
