// scripts/migrate-world.js
import fs from 'fs/promises';
import path from 'path';

async function migrate() {
  const worldDir = path.resolve('world');
  const old = JSON.parse(await fs.readFile(path.join(worldDir, 'world.json'), 'utf8'));
  const zoneId = 0;
  const zoneName = 'The Beginning';
  const zoneDir = path.join(worldDir, 'zones', 'beginning');

  // 1. Create zones/beginning folder
  await fs.mkdir(zoneDir, { recursive: true });

  // 2. Extract old rooms into files
  const roomKeys = Object.keys(old.rooms);
  const index = roomKeys.map((roomKey, idx) => {
    const roomData = old.rooms[roomKey];
    const filename = `${idx}.json`;
    return {
      id: idx,
      key: roomKey, // e.g. "0,0"
      file: filename,
    };
  });

  // 3. Write each room file
  await Promise.all(
    index.map(({ id, file, key }) => {
      const data = old.rooms[key];
      return fs.writeFile(path.join(zoneDir, file), JSON.stringify(data, null, 2), 'utf8');
    })
  );

  // 4. Write zone index.json
  const zoneIndex = index.map(({ id, file }) => ({
    id,
    path: file,
  }));
  await fs.writeFile(
    path.join(zoneDir, 'index.json'),
    JSON.stringify({ rooms: zoneIndex }, null, 2),
    'utf8'
  );

  // 5. Write new top‐level world.json
  const newWorld = {
    zones: [
      {
        id: zoneId,
        name: zoneName,
        path: 'zones/beginning',
        rooms: zoneIndex.map((r) => r.id),
      },
    ],
  };
  await fs.writeFile(path.join(worldDir, 'world.json'), JSON.stringify(newWorld, null, 2), 'utf8');

  console.log('Migration complete!');
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
