import type { WebSocket } from "ws";

/**
 * Manages active WebSocket connections
 */
class WebSocketConnectionManager {
  private connections: Map<number, WebSocket> = new Map();

  /**
   * Add a connection for a user
   */
  addConnection(userId: number, socket: WebSocket): void {
    // Remove any existing connection for this user
    this.removeConnection(userId);
    this.connections.set(userId, socket);
  }

  /**
   * Get a connection for a user
   */
  getConnection(userId: number): WebSocket | undefined {
    return this.connections.get(userId);
  }

  /**
   * Remove a connection for a user
   */
  removeConnection(userId: number): void {
    const socket = this.connections.get(userId);
    if (socket) {
      this.connections.delete(userId);
    }
  }

  /**
   * Send a message to a user if they have an active connection
   */
  sendToUser(userId: number, message: string): boolean {
    const socket = this.connections.get(userId);
    if (socket && socket.readyState === 1) {
      socket.send(message);
      return true;
    }
    return false;
  }

  /**
   * Get the number of active connections
   */
  getConnectionCount(): number {
    return this.connections.size;
  }
}

// Singleton instance
export const wsConnectionManager = new WebSocketConnectionManager();
