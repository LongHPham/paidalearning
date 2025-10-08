const async = require('async');
const _ = require('lodash');

class ConcurrencyManager {
  constructor() {
    this.mutexes = new Map();
    this.gameLocks = new Map();
    this.playerQueues = new Map();
    this.threadPool = [];
    this.maxThreads = 10;
    this.activeThreads = 0;
    
    // Initialize thread pool
    this.initializeThreadPool();
  }

  initializeThreadPool() {
    for (let i = 0; i < this.maxThreads; i++) {
      this.threadPool.push({
        id: i,
        busy: false,
        currentTask: null
      });
    }
  }

  // Mutex implementation for critical sections
  async acquireMutex(resourceId, timeout = 5000) {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error(`Mutex timeout for resource: ${resourceId}`));
      }, timeout);

      const tryAcquire = () => {
        if (!this.mutexes.has(resourceId) || !this.mutexes.get(resourceId).locked) {
          this.mutexes.set(resourceId, {
            locked: true,
            owner: null,
            queue: []
          });
          clearTimeout(timeoutId);
          resolve({
            release: () => this.releaseMutex(resourceId)
          });
        } else {
          // Add to queue
          const mutex = this.mutexes.get(resourceId);
          mutex.queue.push(tryAcquire);
        }
      };

      tryAcquire();
    });
  }

  releaseMutex(resourceId) {
    const mutex = this.mutexes.get(resourceId);
    if (mutex && mutex.locked) {
      mutex.locked = false;
      mutex.owner = null;
      
      // Process next in queue
      if (mutex.queue.length > 0) {
        const next = mutex.queue.shift();
        setTimeout(next, 0); // Async execution
      } else {
        this.mutexes.delete(resourceId);
      }
    }
  }

  // Game-specific locking for multiplayer synchronization
  async acquireGameLock(gameId, playerId, timeout = 3000) {
    return new Promise((resolve, reject) => {
      const lockKey = `game_${gameId}`;
      const timeoutId = setTimeout(() => {
        reject(new Error(`Game lock timeout for game: ${gameId}`));
      }, timeout);

      const tryAcquireGameLock = () => {
        if (!this.gameLocks.has(lockKey) || !this.gameLocks.get(lockKey).locked) {
          this.gameLocks.set(lockKey, {
            locked: true,
            owner: playerId,
            timestamp: Date.now(),
            queue: []
          });
          clearTimeout(timeoutId);
          resolve({
            release: () => this.releaseGameLock(lockKey, playerId)
          });
        } else {
          const lock = this.gameLocks.get(lockKey);
          // Check if lock is stale (older than 10 seconds)
          if (Date.now() - lock.timestamp > 10000) {
            this.gameLocks.delete(lockKey);
            tryAcquireGameLock();
          } else {
            lock.queue.push(tryAcquireGameLock);
          }
        }
      };

      tryAcquireGameLock();
    });
  }

  releaseGameLock(lockKey, playerId) {
    const lock = this.gameLocks.get(lockKey);
    if (lock && lock.owner === playerId) {
      lock.locked = false;
      lock.owner = null;
      
      if (lock.queue.length > 0) {
        const next = lock.queue.shift();
        setTimeout(next, 0);
      } else {
        this.gameLocks.delete(lockKey);
      }
    }
  }

  // Thread pool for concurrent task processing
  async executeInThread(task, priority = 'normal') {
    return new Promise((resolve, reject) => {
      const taskWrapper = {
        id: Date.now() + Math.random(),
        task,
        priority,
        resolve,
        reject,
        timestamp: Date.now()
      };

      // Find available thread
      const availableThread = this.threadPool.find(thread => !thread.busy);
      
      if (availableThread) {
        this.executeTask(availableThread, taskWrapper);
      } else {
        // Add to queue based on priority
        this.addToQueue(taskWrapper);
      }
    });
  }

  addToQueue(taskWrapper) {
    if (!this.playerQueues.has(taskWrapper.priority)) {
      this.playerQueues.set(taskWrapper.priority, []);
    }
    
    const queue = this.playerQueues.get(taskWrapper.priority);
    queue.push(taskWrapper);
    
    // Sort by timestamp for FIFO within same priority
    queue.sort((a, b) => a.timestamp - b.timestamp);
  }

  async executeTask(thread, taskWrapper) {
    thread.busy = true;
    thread.currentTask = taskWrapper;
    this.activeThreads++;

    try {
      const result = await taskWrapper.task();
      taskWrapper.resolve(result);
    } catch (error) {
      taskWrapper.reject(error);
    } finally {
      thread.busy = false;
      thread.currentTask = null;
      this.activeThreads--;
      
      // Process next task in queue
      this.processNextTask();
    }
  }

  processNextTask() {
    const priorities = ['high', 'normal', 'low'];
    
    for (const priority of priorities) {
      const queue = this.playerQueues.get(priority);
      if (queue && queue.length > 0) {
        const availableThread = this.threadPool.find(thread => !thread.busy);
        if (availableThread) {
          const task = queue.shift();
          this.executeTask(availableThread, task);
          break;
        }
      }
    }
  }

  // Player queue management for fair turn-based gameplay
  async addPlayerToQueue(gameId, playerId) {
    const queueKey = `queue_${gameId}`;
    
    if (!this.playerQueues.has(queueKey)) {
      this.playerQueues.set(queueKey, []);
    }
    
    const queue = this.playerQueues.get(queueKey);
    
    if (!queue.includes(playerId)) {
      queue.push(playerId);
    }
    
    return queue.indexOf(playerId);
  }

  getNextPlayer(gameId) {
    const queueKey = `queue_${gameId}`;
    const queue = this.playerQueues.get(queueKey);
    
    if (queue && queue.length > 0) {
      return queue.shift();
    }
    
    return null;
  }

  removePlayerFromQueue(gameId, playerId) {
    const queueKey = `queue_${gameId}`;
    const queue = this.playerQueues.get(queueKey);
    
    if (queue) {
      const index = queue.indexOf(playerId);
      if (index > -1) {
        queue.splice(index, 1);
      }
    }
  }

  // Deadlock prevention and detection
  detectDeadlocks() {
    const deadlocks = [];
    const visited = new Set();
    
    for (const [resourceId, mutex] of this.mutexes) {
      if (mutex.locked && !visited.has(resourceId)) {
        const cycle = this.detectCycle(resourceId, visited);
        if (cycle.length > 0) {
          deadlocks.push(cycle);
        }
      }
    }
    
    return deadlocks;
  }

  detectCycle(resourceId, visited) {
    const cycle = [];
    const currentPath = new Set();
    
    const dfs = (current) => {
      if (currentPath.has(current)) {
        // Cycle detected
        const cycleStart = Array.from(currentPath).indexOf(current);
        return Array.from(currentPath).slice(cycleStart);
      }
      
      if (visited.has(current)) {
        return [];
      }
      
      visited.add(current);
      currentPath.add(current);
      
      const mutex = this.mutexes.get(current);
      if (mutex && mutex.owner) {
        const ownerResources = Array.from(this.mutexes.keys())
          .filter(id => this.mutexes.get(id).owner === mutex.owner);
        
        for (const resource of ownerResources) {
          const result = dfs(resource);
          if (result.length > 0) {
            return result;
          }
        }
      }
      
      currentPath.delete(current);
      return [];
    };
    
    return dfs(resourceId);
  }

  // Cleanup stale locks and resources
  cleanup() {
    const now = Date.now();
    
    // Clean up stale game locks
    for (const [lockKey, lock] of this.gameLocks) {
      if (now - lock.timestamp > 30000) { // 30 seconds
        this.gameLocks.delete(lockKey);
        console.log(`Cleaned up stale game lock: ${lockKey}`);
      }
    }
    
    // Clean up empty queues
    for (const [queueKey, queue] of this.playerQueues) {
      if (queue.length === 0) {
        this.playerQueues.delete(queueKey);
      }
    }
  }

  // Performance monitoring
  getStats() {
    return {
      activeThreads: this.activeThreads,
      maxThreads: this.maxThreads,
      activeMutexes: this.mutexes.size,
      activeGameLocks: this.gameLocks.size,
      queuedTasks: Array.from(this.playerQueues.values())
        .reduce((total, queue) => total + queue.length, 0),
      threadUtilization: (this.activeThreads / this.maxThreads) * 100
    };
  }

  // Start cleanup interval
  startCleanupInterval() {
    setInterval(() => {
      this.cleanup();
    }, 10000); // Clean up every 10 seconds
  }
}

module.exports = ConcurrencyManager;
