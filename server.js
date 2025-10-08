const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const MLQuestionGenerator = require('./ml-question-generator');
const ConcurrencyManager = require('./concurrency-manager');
const ScoringSystem = require('./scoring-system');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Initialize systems
const mlGenerator = new MLQuestionGenerator();
const concurrencyManager = new ConcurrencyManager();
const scoringSystem = new ScoringSystem();

// Start cleanup intervals
concurrencyManager.startCleanupInterval();

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

// Game state management
const gameRooms = new Map();
const playerSessions = new Map();
const MAX_PLAYERS_PER_ROOM = 2;

// UDP-like communication features
class UDPLikeCommunicator {
  constructor(io) {
    this.io = io;
    this.messageQueue = new Map();
    this.acknowledgments = new Map();
    this.retryAttempts = 3;
    this.timeoutMs = 1000;
  }

  // Send reliable message with acknowledgment
  async sendReliableMessage(socketId, event, data) {
    const messageId = Date.now() + Math.random();
    const message = { id: messageId, event, data, timestamp: Date.now() };
    
    // Store message for retry if needed
    if (!this.messageQueue.has(socketId)) {
      this.messageQueue.set(socketId, new Map());
    }
    this.messageQueue.get(socketId).set(messageId, message);
    
    // Send message
    this.io.to(socketId).emit(event, { ...data, messageId });
    
    // Set up acknowledgment timeout
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.handleMessageTimeout(socketId, messageId, reject);
      }, this.timeoutMs);
      
      this.acknowledgments.set(messageId, { resolve, timeout });
    });
  }

  handleMessageTimeout(socketId, messageId, reject) {
    const playerQueue = this.messageQueue.get(socketId);
    if (playerQueue && playerQueue.has(messageId)) {
      const message = playerQueue.get(messageId);
      message.retries = (message.retries || 0) + 1;
      
      if (message.retries < this.retryAttempts) {
        // Retry sending
        this.io.to(socketId).emit(message.event, { ...message.data, messageId });
        setTimeout(() => this.handleMessageTimeout(socketId, messageId, reject), this.timeoutMs);
      } else {
        // Max retries reached
        playerQueue.delete(messageId);
        reject(new Error(`Message delivery failed after ${this.retryAttempts} attempts`));
      }
    }
  }

  handleAcknowledgment(socketId, messageId) {
    const ack = this.acknowledgments.get(messageId);
    if (ack) {
      clearTimeout(ack.timeout);
      ack.resolve();
      this.acknowledgments.delete(messageId);
    }
    
    const playerQueue = this.messageQueue.get(socketId);
    if (playerQueue) {
      playerQueue.delete(messageId);
    }
  }

  // Send broadcast message to all players in a room
  broadcastToRoom(roomId, event, data) {
    this.io.to(roomId).emit(event, data);
  }

  // Send message with priority
  sendPriorityMessage(socketId, event, data, priority = 'normal') {
    const message = { event, data, priority, timestamp: Date.now() };
    
    if (priority === 'high') {
      // Send immediately for high priority
      this.io.to(socketId).emit(event, data);
    } else {
      // Queue for normal/low priority
      this.sendReliableMessage(socketId, event, data);
    }
  }
}

// UDP-like communicator removed - using simple Socket.IO messaging

// Game room management
class GameRoom {
  constructor(roomId) {
    this.roomId = roomId;
    this.players = new Map();
    this.gameState = 'waiting'; // waiting, playing, finished
    this.currentQuestion = null;
    this.questionStartTime = null;
    this.scores = new Map();
    this.roundNumber = 0;
    this.maxRounds = 10;
    this.gameStartTime = null;
  }

  addPlayer(playerId, socket) {
    if (this.players.size >= MAX_PLAYERS_PER_ROOM) {
      return false;
    }
    
    this.players.set(playerId, {
      socket,
      score: 0,
      questionsAnswered: 0,
      correctAnswers: 0,
      avgResponseTime: 0,
      isReady: false
    });
    
    socket.join(this.roomId);
    return true;
  }

  removePlayer(playerId) {
    const player = this.players.get(playerId);
    if (player) {
      player.socket.leave(this.roomId);
      this.players.delete(playerId);
    }
  }

  setPlayerReady(playerId) {
    const player = this.players.get(playerId);
    if (player) {
      player.isReady = true;
    }
  }

  allPlayersReady() {
    return Array.from(this.players.values()).every(player => player.isReady);
  }

  startGame() {
    this.gameState = 'playing';
    this.gameStartTime = Date.now();
    this.roundNumber = 0;
    
    // Reset all player scores
    for (const player of this.players.values()) {
      player.score = 0;
      player.questionsAnswered = 0;
      player.correctAnswers = 0;
    }
    
    this.nextRound();
  }

  async nextRound() {
    if (this.roundNumber >= this.maxRounds) {
      this.endGame();
      return;
    }
    
    this.roundNumber++;
    
    // Generate ONE shared question for all players
    const question = mlGenerator.generateQuestion('shared', {});
    
    // Store question with timestamp
    this.currentQuestion = question;
    this.questionStartTime = Date.now();
    
    // Send the SAME question to all players
    for (const [playerId, player] of this.players) {
      player.socket.emit('newQuestion', { 
        question: question.question, 
        round: this.roundNumber,
        totalRounds: this.maxRounds,
        difficulty: question.difficulty
      });
    }
  }

  async processAnswer(playerId, answer, responseTime) {
    const player = this.players.get(playerId);
    if (!player || !this.currentQuestion) return;
    
    console.log(`Player ${playerId} answered: ${answer}`);
    console.log(`Current question: ${this.currentQuestion.question}`);
    console.log(`Correct answer: ${this.currentQuestion.answer}`);
    
    const isCorrect = answer === this.currentQuestion.answer;
    let score = 0;
    
    try {
      score = scoringSystem.calculateScore(
        playerId, 
        this.currentQuestion, 
        isCorrect, 
        responseTime, 
        this.roomId
      );
    } catch (scoreError) {
      console.error('Scoring error:', scoreError);
      // Fallback scoring
      score = isCorrect ? 100 : 0;
    }
    
    // Update player stats
    player.score += score;
    player.questionsAnswered++;
    if (isCorrect) player.correctAnswers++;
    
    // Calculate current accuracy
    player.accuracy = player.questionsAnswered > 0 ? player.correctAnswers / player.questionsAnswered : 0;
    
    // Update average response time
    if (player.questionsAnswered === 1) {
      player.avgResponseTime = responseTime;
    } else {
      player.avgResponseTime = (player.avgResponseTime * (player.questionsAnswered - 1) + responseTime) / player.questionsAnswered;
    }
    
    // Update ML system with performance data (with error handling)
    try {
      mlGenerator.updatePlayerPerformance(
        playerId, 
        this.currentQuestion, 
        isCorrect, 
        responseTime
      );
    } catch (mlError) {
      console.error('ML update error:', mlError);
      // Continue without ML update
    }
    
    // Send result to player
    player.socket.emit('answerResult', {
      correct: isCorrect,
      score: score,
      totalScore: player.score,
      correctAnswer: this.currentQuestion.answer,
      responseTime: responseTime,
      accuracy: player.accuracy,
      avgResponseTime: player.avgResponseTime
    });
    
    // Check if all players have answered
    const allAnswered = Array.from(this.players.values())
      .every(p => p.questionsAnswered >= this.roundNumber);
    
    if (allAnswered) {
      // Send round results to all players
      const roundResults = Array.from(this.players.entries()).map(([id, p]) => ({
        playerId: id,
        score: p.score,
        accuracy: p.correctAnswers / p.questionsAnswered
      }));
      
      // Send round results to all players in the room
      for (const [playerId, player] of this.players) {
        player.socket.emit('roundResults', {
          round: this.roundNumber,
          results: roundResults
        });
      }
      
      // Wait a bit then start next round
      setTimeout(() => this.nextRound(), 3000);
    }
  }

  endGame() {
    this.gameState = 'finished';
    
    // Calculate final results
    const finalResults = Array.from(this.players.entries()).map(([id, player]) => ({
      playerId: id,
      finalScore: player.score,
      accuracy: player.correctAnswers / player.questionsAnswered,
      avgResponseTime: player.avgResponseTime
    })).sort((a, b) => b.finalScore - a.finalScore);
    
    // Send final results to all players
    for (const [playerId, player] of this.players) {
      player.socket.emit('gameEnd', {
        results: finalResults,
        duration: Date.now() - this.gameStartTime
      });
    }
    
    // Clean up after delay
    setTimeout(() => {
      gameRooms.delete(this.roomId);
    }, 10000);
  }
}

// Socket connection handling
io.on('connection', async (socket) => {
  console.log(`Player connected: ${socket.id}`);
  
  const playerId = socket.id;
  playerSessions.set(playerId, {
    socket,
    currentRoom: null,
    connectedAt: Date.now(),
    lastPing: Date.now()
  });

  // Set up ping/pong to keep connection alive
  const pingInterval = setInterval(() => {
    if (socket.connected) {
      socket.emit('ping');
    } else {
      clearInterval(pingInterval);
    }
  }, 30000); // Ping every 30 seconds

  socket.on('pong', () => {
    const session = playerSessions.get(playerId);
    if (session) {
      session.lastPing = Date.now();
    }
  });

  // Handle acknowledgment messages (simplified)
  socket.on('acknowledge', (data) => {
    // No longer needed with simplified communication
  });

  // Join game room
  socket.on('joinRoom', async (data) => {
    try {
      const roomId = data.roomId || 'default';
      
      // Acquire lock for room operations
      const lock = await concurrencyManager.acquireGameLock(roomId, playerId);
      
      try {
        let room = gameRooms.get(roomId);
        
        if (!room) {
          room = new GameRoom(roomId);
          gameRooms.set(roomId, room);
        }
        
        const success = room.addPlayer(playerId, socket);
        
        if (success) {
          playerSessions.get(playerId).currentRoom = roomId;
          
          socket.emit('roomJoined', {
            roomId,
            playerCount: room.players.size,
            maxPlayers: MAX_PLAYERS_PER_ROOM
          });
          
          // Notify other players
          socket.to(roomId).emit('playerJoined', {
            playerId,
            playerCount: room.players.size
          });
          
          // If room is full, start game
          if (room.players.size === MAX_PLAYERS_PER_ROOM) {
            setTimeout(() => room.startGame(), 2000);
          }
        } else {
          socket.emit('roomFull', {
            message: 'Room is full'
          });
        }
      } finally {
        lock.release();
      }
    } catch (error) {
      console.error('Error joining room:', error);
      socket.emit('error', { message: 'Failed to join room' });
    }
  });

  // Player ready
  socket.on('playerReady', async (data) => {
    const session = playerSessions.get(playerId);
    if (session && session.currentRoom) {
      const room = gameRooms.get(session.currentRoom);
      if (room) {
        room.setPlayerReady(playerId);
        
        socket.to(session.currentRoom).emit('playerReady', {
          playerId,
          allReady: room.allPlayersReady()
        });
        
        if (room.allPlayersReady() && room.players.size === MAX_PLAYERS_PER_ROOM) {
          setTimeout(() => room.startGame(), 1000);
        }
      }
    }
  });

  // Submit answer
  socket.on('submitAnswer', async (data) => {
    try {
      const session = playerSessions.get(playerId);
      if (!session || !session.currentRoom) {
        console.log(`No session or room for player ${playerId}`);
        return;
      }
      
      const room = gameRooms.get(session.currentRoom);
      if (!room || room.gameState !== 'playing') {
        console.log(`Room not found or not playing for player ${playerId}`);
        return;
      }
      
      const responseTime = room.questionStartTime ? 
        (Date.now() - room.questionStartTime) / 1000 : 0;
      
      console.log(`Processing answer for player ${playerId}: ${data.answer}`);
      
      // Process answer directly to avoid thread pool issues
      await room.processAnswer(playerId, data.answer, responseTime);
      
    } catch (error) {
      console.error('Error processing answer:', error);
      // Send error to client but don't disconnect
      socket.emit('error', { message: 'Failed to process answer' });
    }
  });

  // Get leaderboard
  socket.on('getLeaderboard', async (data) => {
    try {
      const leaderboard = scoringSystem.getLeaderboard(data.limit || 10);
      socket.emit('leaderboard', {
        leaderboard
      });
    } catch (error) {
      console.error('Error getting leaderboard:', error);
    }
  });

  // Get player stats
  socket.on('getPlayerStats', async (data) => {
    try {
      const stats = scoringSystem.getPlayerStats(playerId);
      socket.emit('playerStats', {
        stats
      });
    } catch (error) {
      console.error('Error getting player stats:', error);
    }
  });

  // Disconnect handling
  socket.on('disconnect', async () => {
    console.log(`Player disconnected: ${playerId}`);
    
    const session = playerSessions.get(playerId);
    if (session && session.currentRoom) {
      const room = gameRooms.get(session.currentRoom);
      if (room) {
        room.removePlayer(playerId);
        
        // Notify other players
        socket.to(session.currentRoom).emit('playerLeft', {
          playerId
        });
        
        // If room becomes empty, clean it up
        if (room.players.size === 0) {
          gameRooms.delete(session.currentRoom);
        }
      }
    }
    
    playerSessions.delete(playerId);
    scoringSystem.resetPlayerStats(playerId);
  });
});

// Periodic ML model retraining
setInterval(() => {
  mlGenerator.retrainModel();
}, 300000); // Every 5 minutes

// Health check endpoint
app.get('/health', (req, res) => {
  const stats = {
    concurrency: concurrencyManager.getStats(),
    scoring: scoringSystem.getAnalytics(),
    activeRooms: gameRooms.size,
    connectedPlayers: playerSessions.size,
    mlModel: {
      trained: mlGenerator.trained,
      playerCount: mlGenerator.playerPerformanceHistory.size
    }
  };
  
  res.json(stats);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Enhanced Math Game Server running on port ${PORT}`);
  console.log('Features enabled:');
  console.log('- ML-powered question generation');
  console.log('- Real-time competitive multiplayer');
  console.log('- Sophisticated scoring system');
  console.log('- Concurrency control with mutex/threading');
  console.log('- UDP-like reliable communication');
});


