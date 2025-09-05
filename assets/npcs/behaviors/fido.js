module.exports = {
  // Called every tick, after movement
  onTick(npc, gameState) {
    const { playersInRoom, broadcastToRoom } = gameState;
    const near = gameState.playersInRoom(npc.zone, npc.roomId)
                       .some(p => Math.hypot(p.x - npc.x, p.y - npc.y) < 3);
    const toss = Math.random();
    if (!near && toss < .5) {
      let message = '';
      if (toss > .35) {
        message = '🐶';
        broadcastToRoom(npc.zone, npc.roomId, {
          type: 'play-audio',
          key: 'bark',
          options: {
            volume: 0.5
          }
        });
        broadcastToRoom(npc.zone, npc.roomId, {
          type: 'emote',
          instanceId: npc.instanceId,
          text: message
        });
      }
    }
  },

  getContextMenu(npc, player, gameState) {
    return [
      {
        label: 'pet fido',
        action: 'pet-fido'
      },
      {
        label: 'praise fido',
        action: 'give-treat',
        visible: player.inventory && player.inventory.includes('dog_treat')
      }
    ];
  },

  onContextAction(actionId, npc, player, gameState) {
    const { broadcastToRoom, sendToPlayer } = gameState;
    if (actionId === 'pet-fido') {
      console.log(">> " + JSON.stringify(player));
      gameState.sendToPlayer(player.id, {
        type: 'notification',
        text: "Fido wagged his tail."
      });
    } else if (actionId === 'give-treat') {
      broadcastToRoom(npc.zone, npc.roomId, {
        type: 'emote',
        instanceId: npc.instanceId,
        text: 'gobbles up the treat.'
      });
    }
  }
};