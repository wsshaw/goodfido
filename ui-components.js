/**
 * Reusable UI Components with separated concerns
 */

// Configuration for consistent styling values
export const UI_CONFIG = {
  zIndex: {
    contextMenu: 10000,
    overlay: 10000,
  },
  colors: {
    background: '#333',
    text: '#fff',
    border: '#444',
    hover: '#555',
  },
};

/**
 * Generic ContextMenu class that separates template, styling, and logic
 */
export class ContextMenu {
  constructor(options = {}) {
    this.id = options.id || 'context-menu';
    this.items = options.items || [];
    this.position = options.position || { x: 0, y: 0 };
    this.element = null;
    this.onDestroy = options.onDestroy || (() => {});
  }

  /**
   * Create the DOM structure - pure template creation
   */
  createTemplate() {
    const menu = document.createElement('div');
    menu.id = this.id;
    menu.className = 'context-menu';
    
    this.items.forEach(item => {
      const itemEl = document.createElement('div');
      itemEl.className = 'context-menu__item';
      itemEl.textContent = item.label;
      itemEl.dataset.action = item.action;
      menu.appendChild(itemEl);
    });

    return menu;
  }

  /**
   * Position the menu at specified coordinates
   */
  setPosition(x, y) {
    if (this.element) {
      this.element.style.left = `${x}px`;
      this.element.style.top = `${y}px`;
    }
  }

  /**
   * Bind event handlers - separated from DOM creation
   */
  bindEvents() {
    if (!this.element) return;

    // Handle menu item clicks
    this.element.addEventListener('click', (e) => {
      const item = e.target.closest('.context-menu__item');
      if (!item) return;

      const action = item.dataset.action;
      const itemConfig = this.items.find(i => i.action === action);
      
      if (itemConfig && itemConfig.handler) {
        itemConfig.handler();
      }
      
      this.destroy();
    });

    // Click outside to close (deferred to avoid immediate closing)
    setTimeout(() => {
      const handleOutsideClick = (e) => {
        if (!this.element.contains(e.target)) {
          this.destroy();
          document.removeEventListener('click', handleOutsideClick);
        }
      };
      document.addEventListener('click', handleOutsideClick);
    }, 0);
  }

  /**
   * Render the complete menu
   */
  render() {
    // Remove any existing menu
    this.destroy();

    // Create and position
    this.element = this.createTemplate();
    this.setPosition(this.position.x, this.position.y);
    
    // Add to DOM
    document.body.appendChild(this.element);
    
    // Bind interactions
    this.bindEvents();

    return this.element;
  }

  /**
   * Clean up the menu
   */
  destroy() {
    const existing = document.getElementById(this.id);
    if (existing) {
      existing.remove();
    }
    if (this.element) {
      this.element = null;
    }
    this.onDestroy();
  }
}

/**
 * Factory function for inventory context menus
 */
export function createInventoryContextMenu(instance, x, y, dependencies = {}) {
  const { playerTiles, playerId, zone, ws } = dependencies;

  const menuItems = [
    {
      label: 'Examine',
      action: 'examine',
      handler: () => {
        // TODO: implement actual examine logic
        console.log('Examining:', instance);
      }
    },
    {
      label: 'Drop',
      action: 'drop',
      handler: () => {
        const pd = playerTiles[playerId];
        ws.send(JSON.stringify({
          type: 'drop',
          instanceId: instance.instanceId,
          zone: zone.currentRoomX,
          roomId: zone.currentRoomY,
          x: pd.tileX,
          y: pd.tileY,
        }));
      }
    }
  ];

  const contextMenu = new ContextMenu({
    id: 'inventory-menu',
    items: menuItems,
    position: { x, y }
  });

  return contextMenu.render();
}