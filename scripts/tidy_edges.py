import json

with open("world.json", "r") as f:
    world = json.load(f)

rooms = world["rooms"]

for key, room in rooms.items():
    rx, ry = map(int, key.split(","))
    tiles = room.setdefault("tiles", [])

    width = room["width"]
    height = room["height"]

    # Pad tile rows
    while len(tiles) < height:
        tiles.append([{"terrain": "grass"} for _ in range(width)])

    for row in tiles:
        while len(row) < width:
            row.append({"terrain": "grass"})

    for y in range(height):
        # Right edge
        if f"{rx+1},{ry}" in rooms:
            tile = tiles[y][width - 1]
            tile.setdefault("tileExits", {})["right"] = {
                "roomX": rx + 1, "roomY": ry, "x": 0, "y": y
            }
        # Left edge
        if f"{rx-1},{ry}" in rooms:
            tile = tiles[y][0]
            tile.setdefault("tileExits", {})["left"] = {
                "roomX": rx - 1, "roomY": ry, "x": width - 1, "y": y
            }

    for x in range(width):
        # Bottom edge
        if f"{rx},{ry+1}" in rooms:
            tile = tiles[height - 1][x]
            tile.setdefault("tileExits", {})["down"] = {
                "roomX": rx, "roomY": ry + 1, "x": x, "y": 0
            }
        # Top edge
        if f"{rx},{ry-1}" in rooms:
            tile = tiles[0][x]
            tile.setdefault("tileExits", {})["up"] = {
                "roomX": rx, "roomY": ry - 1, "x": x, "y": height - 1
            }

with open("world_updated.json", "w") as f:
    json.dump(world, f, indent=2)

print("✅ world_updated.json written with full edge connections and tile padding.")
