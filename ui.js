/**
 * good-fido: UI helpers (browser DOM, Phaser overlays) for client
 * -------------------------------------------------------------------------------
 * - Inventory UI, context menus, and an in-game console.
 * - Tile/exit editor panel for wizard/edit mode.
 * - Character info overlay with tabs (Player / Inspector).
 *
 * Conventions
 * - DOM-first: build elements with minimal CSS inline for portability.
 * - Non-destructive: UI functions avoid side effects outside the DOM/UIRefs.
 * - Server-authoritative: editing actions emit lightweight WebSocket messages.
 */
import {
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
  uiRefs,
  ws,
  zone,
} from './client_main.js';

let editGridGraphics = null;
let tileHighlight = null;

/**
 * Re-render the inventory grid inside the char-info overlay.
 * Each item renders as a TILE_SIZE icon (or text fallback) with a context menu.
 * Reads: myInventory, objectTypes, assets.
 */
export function updateInventoryUI() {
  const invDiv = document.getElementById('char-info-items');
  if (!invDiv) return;
  invDiv.innerHTML = ''; // clear out existing icons
  myInventory.forEach((inst) => {
    const def = objectTypes[inst.typeId] || {};
    const key = def.sprite;
    const src = assets[key]?.src;
    const el = src
      ? (() => {
          const img = document.createElement('img');
          img.src = src;
          img.width = TILE_SIZE;
          img.height = TILE_SIZE;
          return img;
        })()
      : (() => {
          const span = document.createElement('span');
          span.textContent = def.name || 'Unknown';
          return span;
        })();
    el.style.margin = '2px';
    el.style.cursor = 'pointer';
    el.addEventListener('click', (e) => {
      // Open an item-scoped context menu without bubbling to parent handlers.
      e.stopPropagation();
      showInventoryContextMenu(inst, e.clientX, e.clientY);
    });
    invDiv.appendChild(el);
  });
}

/**
 * Draw a simple right-click menu for an inventory item (Examine / Drop).
 * Positions at client (x,y) and self-cleans on outside click.
 * Emits: { type:'drop', instanceId, zone, roomId, x, y }.
 */
export function showInventoryContextMenu(instance, x, y) {
  // Ensure only one inventory menu exists at a time
  const old = document.getElementById('inventory-menu');
  if (old) old.remove();
  // create menu container
  const menu = document.createElement('div');
  menu.id = 'inventory-menu';
  // TODO: so much of this styling stuff needs to be outside of the logic. Big debt
  // but put a pin in it for speed
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
  // examine option
  const examine = document.createElement('div');
  examine.textContent = 'Examine';
  examine.style.padding = '4px';
  examine.style.cursor = 'pointer';
  examine.addEventListener('click', () => {
    // Placeholder: wire to server/inspector logic if desired
    // TODO: implement actual examine logic ...
    menu.remove();
  });
  menu.appendChild(examine);
  // drop option
  const drop = document.createElement('div');
  drop.textContent = 'Drop';
  drop.style.padding = '4px';
  drop.style.cursor = 'pointer';
  drop.addEventListener('click', () => {
    // Drop at the player's current tile (server will validate and broadcast)
    // send drop to server at player's current tile
    const pd = playerTiles[playerId];
    ws.send(
      JSON.stringify({
        type: 'drop',
        instanceId: instance.instanceId,
        zone: zone.currentRoomX,
        roomId: zone.currentRoomY,
        x: pd.tileX,
        y: pd.tileY,
      })
    );
    menu.remove();
  });
  menu.appendChild(drop);
  document.body.appendChild(menu);
  // click outside to close (deferred so opening click isn't caught)
  setTimeout(() => {
    document.addEventListener('click', function handler(e) {
      if (!menu.contains(e.target)) {
        menu.remove();
        document.removeEventListener('click', handler);
      }
    });
  }, 0);
}

/**
 * Create the character info overlay with tabs (Player / Inspector).
 * Idempotent: removes pre-existing overlay before constructing anew.
 * Persists active tab to localStorage.
 */
export function createCharInfoOverlay() {
  // ...remove any existing one first
  removeCharInfoOverlay();

  // Player header (name) and inventory panel

  // Create overlay container
  const overlay = document.createElement('div');
  overlay.id = 'char-info';
  Object.assign(overlay.style, {
    position: 'absolute',
    top: '20px',
    right: '20px',
    width: '300px',
    background: '#222',
    color: '#fff',
    border: '2px solid #444',
    borderRadius: '8px',
    padding: '8px',
    boxSizing: 'border-box',
    zIndex: 10000,
    cursor: 'default',
  });

  // Tab navigation
  const tabsContainer = document.createElement('div');
  Object.assign(tabsContainer.style, {
    display: 'flex',
    marginBottom: '8px',
    borderBottom: '1px solid #444',
  });
  const playerTab = document.createElement('div');
  playerTab.textContent = 'player';
  const inspectorTab = document.createElement('div');
  inspectorTab.textContent = 'Inspector';
  [playerTab, inspectorTab].forEach((tabEl) => {
    Object.assign(tabEl.style, {
      padding: '4px 8px',
      cursor: 'pointer',
    });
  });
  tabsContainer.append(playerTab, inspectorTab);
  overlay.appendChild(tabsContainer);

  // Content areas
  const playerContent = document.createElement('div');
  const inspectorContent = document.createElement('div');
  inspectorContent.style.display = 'none';
  overlay.appendChild(playerContent);
  overlay.appendChild(inspectorContent);

  // Close button
  const closeBtn = document.createElement('span');
  closeBtn.textContent = '✕';
  Object.assign(closeBtn.style, {
    position: 'absolute',
    top: '4px',
    right: '6px',
    cursor: 'pointer',
  });
  closeBtn.addEventListener('click', removeCharInfoOverlay);
  overlay.appendChild(closeBtn);

  // ---- Player Info tab content ----
  // Header with player name
  const header = document.createElement('div');
  const playerName = playerTiles[playerId]?.name || '';
  header.textContent = playerName;
  header.style.fontWeight = '200';
  header.style.marginBottom = '8px';
  playerContent.appendChild(header);

  // Inventory container
  const invDiv = document.createElement('div');
  invDiv.id = 'char-info-items';
  playerContent.appendChild(invDiv);
  updateInventoryUI();

  // ---- Inspector tab content (placeholder) ----
  const inspectorPlaceholder = document.createElement('div');
  inspectorPlaceholder.textContent = 'Inspector panel';
  inspectorContent.appendChild(inspectorPlaceholder);

  // Tab switcher: toggles content panes and persists selection
  function activateTab(tab) {
    if (tab === 'player') {
      playerContent.style.display = 'block';
      inspectorContent.style.display = 'none';
      playerTab.style.borderBottom = '2px solid #fff';
      inspectorTab.style.borderBottom = '';
    } else {
      playerContent.style.display = 'none';
      inspectorContent.style.display = 'block';
      inspectorTab.style.borderBottom = '2px solid #fff';
      playerTab.style.borderBottom = '';
    }
    localStorage.setItem('lastInfoTab', tab);
  }
  playerTab.addEventListener('click', () => activateTab('player'));
  inspectorTab.addEventListener('click', () => activateTab('inspector'));

  // Initialize to last active tab, defaulting to player
  const last = localStorage.getItem('lastInfoTab') || 'player';
  activateTab(last);

  // Add to DOM and track reference
  document.body.appendChild(overlay);
  uiRefs.charInfoEl = overlay;
  uiRefs.inspectorContentEl = inspectorContent;
  uiRefs.activateTab = activateTab;
}

/** Remove and forget the character info overlay (if present). */
export function removeCharInfoOverlay() {
  if (uiRefs.charInfoEl) {
    uiRefs.charInfoEl.remove();
    uiRefs.charInfoEl = null;
  }
}

/**
 * Overlay a tile grid for edit mode.
 * Drawn with Phaser Graphics; follows camera scroll.
 */
export function updateEditGrid(scene) {
  // Destroy any old grid
  if (editGridGraphics) {
    editGridGraphics.clear();
    editGridGraphics.destroy();
    editGridGraphics = null;
  }
  // If we’re not in edit mode, nothing more to do
  if (!editMode) return;

  // Fresh graphics layer for the grid; previous layer cleared/destroyed
  const room = getCurrentRoom();
  const g = scene.add.graphics();
  // 1px, light gray, semi‐transparent
  g.lineStyle(1, 0xcccccc, 0.5);

  // vertical lines
  for (let x = 0; x <= room.width; x++) {
    g.moveTo(x * TILE_SIZE, 0);
    g.lineTo(x * TILE_SIZE, room.height * TILE_SIZE);
  }
  // horizontal lines
  for (let y = 0; y <= room.height; y++) {
    g.moveTo(0, y * TILE_SIZE);
    g.lineTo(room.width * TILE_SIZE, y * TILE_SIZE);
  }
  g.strokePath();
  g.setDepth(5); // above tiles but below UI
  g.setScrollFactor(1); // scrolls with the map
  editGridGraphics = g;
}

/**
 * Responsive layout for the floating console (info panel + log panel).
 * Collapses the log column on narrow viewports.
 */
export function updateConsoleLayout() {
  const consoleEl = document.getElementById('floating-console');
  const logPanel = document.getElementById('log-panel');
  if (!consoleEl || !logPanel) return;
  const infoPanel = document.getElementById('info-panel');

  if (window.innerWidth < 600) {
    // Narrow: hide log panel
    logPanel.style.display = 'none';
    consoleEl.style.width = 'auto';
    if (infoPanel) {
      infoPanel.style.width = '100%';
      infoPanel.style.borderRight = 'none';
    }
  } else {
    // Wide: show log panel again
    logPanel.style.display = 'block';
    consoleEl.style.width = '75%';
    if (infoPanel) {
      infoPanel.style.width = '25%';
      infoPanel.style.borderRight = '1px solid #444';
    }
  }
}

/**
 * Open the tile editor panel centered on screen and highlight (tx,ty).
 * Allows terrain change, custom behavior selection, tile exits, and room resize.
 * Emits: 'edit-tile', 'edit-tile-behavior', 'edit-tile-exits', 'resize-room'.
 * Relies on: currentScene (for highlight), zone/getCurrentRoom(), ws.
 */
export function showTerrainSelector(tx, ty) {
  const room = getCurrentRoom();
  if (tx < 0 || ty < 0 || tx >= room.width || ty >= room.height) {
    log('edit mode but invalid tile coordinates!');
    return;
  }
  // Clear any existing tile highlight
  if (tileHighlight) {
    tileHighlight.destroy();
    tileHighlight = null;
  }
  // Remove any existing panel
  const existing = document.getElementById('terrain-selector');
  if (existing) document.body.removeChild(existing);

  // Floating inspection panel
  const panel = document.createElement('div');
  panel.id = 'terrain-selector';
  Object.assign(panel.style, {
    position: 'absolute',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    width: '320px',
    maxHeight: '80vh',
    background: '#222',
    padding: '12px',
    border: '2px solid #444',
    borderRadius: '8px',
    overflowY: 'auto',
    zIndex: 10000,
    boxSizing: 'border-box',
  });

  // ... rest of tile editing UI ...

  // Visual selection: yellow rectangle on the target tile
  // Draw a highlight rectangle around the selected tile
  const worldX = tx * TILE_SIZE;
  const worldY = ty * TILE_SIZE;
  tileHighlight = currentScene.add
    .rectangle(worldX, worldY, TILE_SIZE, TILE_SIZE)
    .setOrigin(0)
    .setStrokeStyle(2, 0xffff00)
    .setDepth(1000)
    .setScrollFactor(1);

  // Header showing tile coords
  const header = document.createElement('div');
  header.textContent = `Tile (${tx}, ${ty})`;
  header.style.color = 'white';
  header.style.marginBottom = '8px';
  panel.appendChild(header);

  // --- Tile behavior (physics rules) ---------------------------------------------------------
  // Behavior selector dropdown
  const behaviorContainer = document.createElement('div');
  behaviorContainer.style.marginBottom = '8px';
  const behaviorLabel = document.createElement('label');
  behaviorLabel.textContent = 'Custom behavior: ';
  behaviorLabel.style.color = 'white';
  behaviorLabel.htmlFor = 'tile-behavior-select';
  const behaviorSelect = document.createElement('select');
  behaviorSelect.id = 'tile-behavior-select';
  // default blank option
  const noneOption = new Option('None', '');
  behaviorSelect.add(noneOption);
  // populate from tileProperties
  Object.entries(physicsRules).forEach(([key, props]) => {
    const opt = new Option(props.displayName || key, key);
    behaviorSelect.add(opt);
  });
  // set current tile behavior if present
  const currentBehavior = room.tiles[ty][tx].behavior || '';
  behaviorSelect.value = currentBehavior;
  // on change, send update to server
  behaviorSelect.addEventListener('change', () => {
    // Persist behavior to server; blank value removes behavior key
    const newBehavior = behaviorSelect.value || null;
    ws.send(
      JSON.stringify({
        type: 'edit-tile-behavior',
        roomId: zone.currentRoomY,
        zoneId: zone.currentRoomX,
        x: tx,
        y: ty,
        behavior: newBehavior,
      })
    );
  });
  behaviorContainer.appendChild(behaviorLabel);
  behaviorContainer.appendChild(behaviorSelect);
  panel.appendChild(behaviorContainer);

  // Make the panel draggable by its header
  let isDragging = false;
  let dragOffsetX = 0,
    dragOffsetY = 0;
  header.style.cursor = 'move';
  header.addEventListener('mousedown', (e) => {
    isDragging = true;
    // Convert to absolute positioning
    const rect = panel.getBoundingClientRect();
    panel.style.left = `${rect.left}px`;
    panel.style.top = `${rect.top}px`;
    panel.style.transform = '';
    dragOffsetX = e.clientX - rect.left;
    dragOffsetY = e.clientY - rect.top;
  });
  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    panel.style.left = `${e.clientX - dragOffsetX}px`;
    panel.style.top = `${e.clientY - dragOffsetY}px`;
  });
  document.addEventListener('mouseup', () => {
    isDragging = false;
  });

  // --- Terrain picker (image grid) -----------------------------------------------------------
  // Terrain icons grid
  const grid = document.createElement('div');
  Object.assign(grid.style, {
    display: 'grid',
    gridTemplateColumns: `repeat(auto-fill, ${TILE_SIZE}px)`,
    gap: '6px',
  });
  Object.entries(assets).forEach(([terrain, def]) => {
    const img = document.createElement('img');
    img.src = def.src;
    img.width = TILE_SIZE;
    img.height = TILE_SIZE;
    img.style.cursor = 'pointer';
    img.title = terrain;
    img.addEventListener('click', () => {
      // Send terrain patch for the selected tile; UI highlights the chosen sprite
      // Send the edit message
      ws.send(
        JSON.stringify({
          type: 'edit-tile',
          roomId: zone.currentRoomY,
          zoneId: zone.currentRoomX,
          x: tx,
          y: ty,
          terrain,
        })
      );
      // Highlight selected icon
      Array.from(grid.children).forEach((child) => (child.style.border = ''));
      img.style.border = '2px solid yellow';
    });
    grid.appendChild(img);
  });
  panel.appendChild(grid);

  // --- Tile Exit Editor ---
  const exitsDef = room.tiles[ty][tx].tileExits || {};
  const exitDirections = ['up', 'down', 'left', 'right'];
  const exitsContainer = document.createElement('div');
  exitsContainer.style.margin = '8px 0';
  const exitsHeader = document.createElement('div');
  exitsHeader.textContent = 'Exits:';
  exitsHeader.style.color = 'white';
  exitsHeader.style.marginBottom = '4px';
  exitsContainer.appendChild(exitsHeader);

  exitDirections.forEach((dir) => {
    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.alignItems = 'center';
    row.style.gap = '4px';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = `exit-${dir}`;
    if (exitsDef[dir]) checkbox.checked = true;
    row.appendChild(checkbox);
    const label = document.createElement('label');
    label.htmlFor = `exit-${dir}`;
    label.textContent = dir + ':';
    label.style.color = 'white';
    row.appendChild(label);
    ['roomId', 'x', 'y'].forEach((field) => {
      const input = document.createElement('input');
      input.type = 'number';
      input.id = `exit-${dir}-${field}`;
      input.placeholder = field;
      input.style.width = '50px';
      if (exitsDef[dir] && exitsDef[dir][field] !== undefined) {
        input.value = exitsDef[dir][field];
      }
      row.appendChild(input);
    });
    exitsContainer.appendChild(row);
  });
  panel.appendChild(exitsContainer);

  // “Apply Exits” button
  const applyExitsBtn = document.createElement('button');
  applyExitsBtn.textContent = 'Apply Exits';
  applyExitsBtn.style.cursor = 'pointer';
  applyExitsBtn.style.marginBottom = '8px';
  panel.appendChild(applyExitsBtn);

  applyExitsBtn.addEventListener('click', () => {
    // Collect enabled exits into a compact object (omit if empty)
    const newExits = {};
    exitDirections.forEach((dir) => {
      const enabled = document.getElementById(`exit-${dir}`).checked;
      if (enabled) {
        const roomIdVal = parseInt(document.getElementById(`exit-${dir}-roomId`).value, 10);
        const xVal = parseInt(document.getElementById(`exit-${dir}-x`).value, 10);
        const yVal = parseInt(document.getElementById(`exit-${dir}-y`).value, 10);
        if (!isNaN(roomIdVal) && !isNaN(xVal) && !isNaN(yVal)) {
          newExits[dir] = { roomId: roomIdVal, x: xVal, y: yVal };
        }
      }
    });
    // Build payload: include tileExits only if non-empty
    const payload = {
      type: 'edit-tile-exits',
      roomId: zone.currentRoomY,
      zoneId: zone.currentRoomX,
      x: tx,
      y: ty,
      tileExits: Object.keys(newExits).length ? newExits : null,
    };
    ws.send(JSON.stringify(payload));
    log(`Updated exits for tile (${tx},${ty})`);
  });

  // Highlight the currently applied terrain for this tile
  const currentTerrain =
    zone.rooms[`${zone.currentRoomX},${zone.currentRoomY}`].tiles[ty][tx].terrain;
  Array.from(grid.children).forEach((child) => {
    if (child.title === currentTerrain) {
      child.style.border = '2px solid yellow';
    }
  });

  // Separator before room resize controls
  const hrResize = document.createElement('hr');
  hrResize.style.margin = '8px 0';
  hrResize.style.borderColor = '#444';
  panel.appendChild(hrResize);

  // --- Room size editor ----------------------------------------------------------------------
  // Room resize controls (wizard-only)
  const resizeContainer = document.createElement('div');
  Object.assign(resizeContainer.style, {
    display: 'flex',
    alignItems: 'center',
    marginBottom: '8px',
    gap: '4px',
  });
  // Width input
  const widthInput = document.createElement('input');
  widthInput.type = 'number';
  widthInput.min = '1';
  widthInput.value = room.width;
  widthInput.style.width = '60px';
  // Height input
  const heightInput = document.createElement('input');
  heightInput.type = 'number';
  heightInput.min = '1';
  heightInput.value = room.height;
  heightInput.style.width = '60px';
  // Button
  const resizeBtn = document.createElement('button');
  resizeBtn.textContent = 'Resize Room';
  resizeBtn.style.cursor = 'pointer';
  let clown = document.createElement('span');
  clown.innerHTML = 'Room size:';
  clown.style.color = 'white';
  resizeContainer.appendChild(clown);
  resizeContainer.appendChild(widthInput);
  resizeContainer.appendChild(document.createTextNode('×'));
  resizeContainer.appendChild(heightInput);
  resizeContainer.appendChild(resizeBtn);
  panel.appendChild(resizeContainer);

  // Handle resize click
  resizeBtn.addEventListener('click', () => {
    // Validate, prompt on shrink, mutate local room tiles, then redraw and notify server
    const newW = parseInt(widthInput.value, 10);
    const newH = parseInt(heightInput.value, 10);
    if (newW < 1 || newH < 1) {
      return alert('Dimensions must be at least 1×1');
    }
    const oldW = room.width,
      oldH = room.height;
    if (newW < oldW || newH < oldH) {
      if (!confirm('Shrinking will discard tiles. Proceed?')) return;
    }
    // Adjust width: extend rows with blank tiles or truncate
    for (let y = 0; y < room.tiles.length; y++) {
      const row = room.tiles[y];
      if (newW > oldW) {
        for (let x = oldW; x < newW; x++) {
          row.push({ terrain: 'blank', tileExits: {} });
        }
      } else if (newW < oldW) {
        row.length = newW;
      }
    }
    // Adjust height: append or remove rows
    if (newH > oldH) {
      for (let y = oldH; y < newH; y++) {
        const newRow = [];
        for (let x = 0; x < newW; x++) {
          newRow.push({ terrain: 'blank', tileExits: {} });
        }
        room.tiles.push(newRow);
      }
    } else if (newH < oldH) {
      room.tiles.length = newH;
    }
    room.width = newW;
    room.height = newH;
    // Redraw scene and re-center camera (relies on global adjustCameraCentering)
    drawRoom(currentScene);
    adjustCameraCentering(currentScene);
    log(`Resized room to ${newW}×${newH}`);
    ws.send(
      JSON.stringify({
        type: 'resize-room',
        roomId: zone.currentRoomY,
        zoneId: zone.currentRoomX,
        width: newW,
        height: newH,
      })
    );
  });

  // Spacer before close button
  const spacer = document.createElement('div');
  spacer.style.height = '4px';
  panel.appendChild(spacer);

  // --- Panel controls ------------------------------------------------------------------------
  // Close button (X)
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  Object.assign(closeBtn.style, {
    position: 'absolute',
    top: '4px',
    right: '4px',
    width: '24px',
    height: '24px',
    padding: '0',
    background: 'transparent',
    color: '#fff',
    border: 'none',
    fontSize: '18px',
    cursor: 'pointer',
  });
  closeBtn.addEventListener('click', () => {
    document.body.removeChild(panel);
    // Remove tile highlight when inspector closes
    if (tileHighlight) {
      tileHighlight.destroy();
      tileHighlight = null;
    }
  });
  panel.appendChild(closeBtn);

  // Add a resize handle in the bottom-right corner
  const resizeHandle = document.createElement('div');
  Object.assign(resizeHandle.style, {
    position: 'absolute',
    width: '12px',
    height: '12px',
    bottom: '4px',
    right: '4px',
    cursor: 'se-resize',
    background: '#aaa',
    borderRadius: '2px',
    zIndex: 10001,
  });
  panel.appendChild(resizeHandle);

  let isResizing = false;
  let startW, startH, startX, startY;

  resizeHandle.addEventListener('mousedown', (e) => {
    isResizing = true;
    startW = panel.offsetWidth;
    startH = panel.offsetHeight;
    startX = e.clientX;
    startY = e.clientY;
    e.stopPropagation();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isResizing) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    panel.style.width = `${startW + dx}px`;
    panel.style.height = `${startH + dy}px`;
  });

  document.addEventListener('mouseup', () => {
    isResizing = false;
  });

  document.body.appendChild(panel);
}

/**
 * Create a docked bottom console with two columns:
 * - Left: location/time info; Right: scrollable log panel.
 * (Noop if already there)
 */
export function createFloatingConsole() {
  const existing = document.getElementById('floating-console');
  if (existing) return;
  // Root container for console (absolute, centered, responsive width)
  const panel = document.createElement('div');
  panel.id = 'floating-console';
  Object.assign(panel.style, {
    position: 'absolute',
    bottom: '16px',
    left: '50%',
    transform: 'translateX(-50%)',
    width: '75%',
    height: '20%',
    background: 'rgba(17,17,17,0.8)',
    color: '#fefefe',
    border: '2px solid #444',
    borderRadius: '8px',
    display: 'flex',
    flexDirection: 'row',
    fontFamily: gameFont,
    fontSize: '14px',
    fontWeight: '100',
    zIndex: 10000,
    boxSizing: 'border-box',
  });

  const infoPanel = document.createElement('div');
  infoPanel.id = 'info-panel';
  Object.assign(infoPanel.style, {
    width: '25%',
    padding: '8px',
    borderRight: '1px solid #444',
    boxSizing: 'border-box',
  });
  infoPanel.innerHTML = `
    <div id="location-info">
      Zone: N/A<br>
      Room: N/A
    </div>
    <hr style="margin: 8px 0; border-color: #444;">
    <div id="time-info">Loading time…</div>
  `;

  const logPanel = document.createElement('div');
  logPanel.id = 'log-panel';
  Object.assign(logPanel.style, {
    width: '75%',
    padding: '8px',
    overflowY: 'auto',
    boxSizing: 'border-box',
  });

  panel.appendChild(infoPanel);
  panel.appendChild(logPanel);
  document.body.appendChild(panel);
}

/**
 * Switch to the Inspector tab and populate with NPC/Object data.
 * Renders name, optional sprite image, and description.
 */
export function openInspectorPanel({ name, spriteKey, description }) {
  if (!uiRefs.charInfoEl) createCharInfoOverlay();
  uiRefs.activateTab('inspector');
  const c = uiRefs.inspectorContentEl;
  c.innerHTML = '';
  // Title
  const title = document.createElement('div');
  title.style = 'font-size:1.2em;font-weight:bold;margin-bottom:8px';
  title.textContent = name;
  c.appendChild(title);
  // Image
  if (spriteKey && window.assets?.[spriteKey]?.src) {
    const img = document.createElement('img');
    img.src = window.assets[spriteKey].src;
    img.style = 'width:64px;height:64px;display:block;margin-bottom:8px';
    c.appendChild(img);
  }
  // Description
  if (description) {
    const desc = document.createElement('div');
    desc.textContent = description;
    c.appendChild(desc);
  }
}
