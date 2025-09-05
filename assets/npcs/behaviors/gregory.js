/**
 * custom behavior module: 
 */
module.exports = {
    // Called every tick, after movement
    onTick(npc, gameState) {
      const { playersInRoom, broadcastToRoom } = gameState;
      const near = gameState.playersInRoom(npc.zone, npc.roomId)
                         .some(p => Math.hypot(p.x - npc.x, p.y - npc.y) < 3);
      const toss = Math.random();
      if (!near && toss < .3) {
        let message = '';
        if (toss > .15) {
          message = 'Purchase';
          broadcastToRoom(npc.zone, npc.roomId, {
            type: 'emote',
            instanceId: npc.instanceId,
            text: message
          });
        }
      }
    }
  };
  