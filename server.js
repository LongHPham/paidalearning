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
  constructor(roomId, isBotMode = false, questionCount = 10) {
    this.roomId = roomId;
    this.players = new Map();
    this.gameState = 'waiting'; // waiting, playing, finished
    this.currentQuestion = null;
    this.questionStartTime = null;
    this.scores = new Map();
    this.roundNumber = 0;
    this.maxRounds = questionCount;
    this.gameStartTime = null;
    this.isBotMode = isBotMode;
    this.botPlayer = null;
    this.botDifficulty = 0.5; // Bot's current difficulty level
  }

  addPlayer(playerId, socket) {
    if (this.players.size >= MAX_PLAYERS_PER_ROOM && !this.isBotMode) {
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

  addBotPlayer() {
    if (this.isBotMode && !this.botPlayer) {
      const botId = 'bot_' + this.roomId;
      this.botPlayer = {
        id: botId,
        score: 0,
        questionsAnswered: 0,
        correctAnswers: 0,
        avgResponseTime: 0,
        isReady: true,
        difficulty: this.botDifficulty
      };
      this.players.set(botId, this.botPlayer);
      return true;
    }
    return false;
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
    
    // Add bot player if in bot mode
    if (this.isBotMode) {
      this.addBotPlayer();
    }
    
    this.nextRound();
  }

  async nextRound() {
    if (this.roundNumber >= this.maxRounds) {
      this.endGame();
      return;
    }
    
    this.roundNumber++;
    
    // Generate ONE shared question for all players with adaptive difficulty
    // Use the average accuracy of all players to determine difficulty
    const avgAccuracy = Array.from(this.players.values())
      .reduce((sum, player) => sum + (player.accuracy || 0.7), 0) / this.players.size;
    
    const adaptiveDifficulty = mlGenerator.getAdaptiveDifficulty('shared', avgAccuracy);
    const question = mlGenerator.generateUniqueQuestion('shared', adaptiveDifficulty);
    
    // Store question with timestamp
    this.currentQuestion = question;
    this.questionStartTime = Date.now();
    
    // Send the SAME question to all players
    for (const [playerId, player] of this.players) {
      if (player.socket) { // Real player
        player.socket.emit('newQuestion', { 
          question: question.question, 
          round: this.roundNumber,
          totalRounds: this.maxRounds,
          difficulty: question.difficulty
        });
      }
    }

    // If bot mode, make bot answer after a delay
    if (this.isBotMode && this.botPlayer) {
      this.simulateBotAnswer(question);
    }
  }

  simulateBotAnswer(question) {
    // Calculate bot response time based on difficulty and performance
    const baseTime = 2 + (question.difficulty === 'hard' ? 3 : question.difficulty === 'medium' ? 2 : 1);
    const variation = Math.random() * 1.5; // Add some randomness
    const responseTime = baseTime + variation;
    
    // Calculate bot accuracy based on current difficulty
    const accuracy = Math.max(0.4, Math.min(0.85, this.botDifficulty + (Math.random() - 0.5) * 0.2));
    const isCorrect = Math.random() < accuracy;
    
    // Bot answers correctly or incorrectly
    const answer = isCorrect ? question.answer : this.generateWrongAnswer(question.answer);
    
    console.log(`Bot answering: ${answer} (correct: ${question.answer}, isCorrect: ${isCorrect})`);
    
    // Process bot answer after delay
    setTimeout(() => {
      this.processAnswer(this.botPlayer.id, answer, responseTime);
    }, responseTime * 1000);
  }

  generateWrongAnswer(correctAnswer) {
    // Generate a plausible wrong answer
    const numAnswer = parseInt(correctAnswer);
    if (!isNaN(numAnswer)) {
      const variation = Math.floor(Math.random() * 10) + 1;
      return Math.random() < 0.5 ? (numAnswer + variation).toString() : (numAnswer - variation).toString();
    }
    return 'wrong';
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
    
    // Update bot difficulty based on player performance
    if (this.isBotMode && playerId !== this.botPlayer.id) {
      this.adjustBotDifficulty(player.accuracy);
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
    
    // Send result to player (only if it's a real player)
    if (player.socket) {
      player.socket.emit('answerResult', {
        correct: isCorrect,
        score: score,
        totalScore: player.score,
        correctAnswer: this.currentQuestion.answer,
        responseTime: responseTime,
        accuracy: player.accuracy,
        avgResponseTime: player.avgResponseTime
      });
    }
    
    // If this is a bot answer, notify the real player
    if (this.isBotMode && playerId === this.botPlayer.id && this.players.size > 1) {
      const realPlayer = Array.from(this.players.values()).find(p => p.socket);
      if (realPlayer) {
        realPlayer.socket.emit('botAnswer', {
          botAnswer: answer,
          correct: isCorrect,
          correctAnswer: this.currentQuestion.answer,
          botScore: player.score,
          botAccuracy: player.accuracy
        });
      }
    }
    
    // Check if all players have answered
    const allAnswered = Array.from(this.players.values())
      .every(p => p.questionsAnswered >= this.roundNumber);
    
    if (allAnswered) {
      // Wait for players to see their individual results before showing round complete
      setTimeout(() => {
        // Send round results to all players
        const roundResults = Array.from(this.players.entries()).map(([id, p]) => ({
          playerId: id,
          score: p.score,
          accuracy: p.correctAnswers / p.questionsAnswered
        }));
        
        // Send round results to all real players in the room
        for (const [playerId, player] of this.players) {
          if (player.socket) {
            player.socket.emit('roundResults', {
              round: this.roundNumber,
              results: roundResults
            });
          }
        }
        
        // Wait a bit then start next round
        setTimeout(() => this.nextRound(), 2000);
      }, 2000); // 2 second delay to show individual results
    }
  }

  adjustBotDifficulty(playerAccuracy) {
    // Adjust bot difficulty to match player performance
    if (playerAccuracy > 0.8) {
      this.botDifficulty = Math.min(0.9, this.botDifficulty + 0.1);
    } else if (playerAccuracy < 0.5) {
      this.botDifficulty = Math.max(0.3, this.botDifficulty - 0.1);
    }
    
    if (this.botPlayer) {
      this.botPlayer.difficulty = this.botDifficulty;
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
        let isFirstPlayer = false;
        
        if (!room) {
          // First player creates room and can set question count
          const questionCount = data.questionCount || 10;
          room = new GameRoom(roomId, false, questionCount);
          gameRooms.set(roomId, room);
          isFirstPlayer = true;
        }
        
        const success = room.addPlayer(playerId, socket);
        
        if (success) {
          playerSessions.get(playerId).currentRoom = roomId;
          
          socket.emit('roomJoined', {
            roomId,
            playerCount: room.players.size,
            maxPlayers: MAX_PLAYERS_PER_ROOM,
            isFirstPlayer: isFirstPlayer,
            questionCount: room.maxRounds
          });
          
          // Notify other players
          socket.to(roomId).emit('playerJoined', {
            playerId,
            playerCount: room.players.size
          });
          
          // If room is full, start game immediately
          if (room.players.size === MAX_PLAYERS_PER_ROOM) {
            setTimeout(() => room.startGame(), 1000);
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

  // Start bot game
  socket.on('startBotGame', async (data) => {
    try {
      const roomId = 'bot_' + playerId;
      
      // Create bot room
      const room = new GameRoom(roomId, true, data.questionCount);
      gameRooms.set(roomId, room);
      
      // Add player to bot room
      const success = room.addPlayer(playerId, socket);
      
      if (success) {
        playerSessions.get(playerId).currentRoom = roomId;
        
        // Add bot player
        room.addBotPlayer();
        
        socket.emit('roomJoined', {
          roomId,
          playerCount: 2, // Player + Bot
          maxPlayers: 2,
          isBotMode: true
        });
        
        // Start bot game immediately
        setTimeout(() => {
          console.log('Starting bot game...');
          room.startGame();
        }, 1000);
      }
    } catch (error) {
      console.error('Error starting bot game:', error);
      socket.emit('error', { message: 'Failed to start bot game' });
    }
  });

  // Update room settings
  socket.on('updateRoomSettings', async (data) => {
    try {
      const session = playerSessions.get(playerId);
      if (!session || !session.currentRoom) {
        socket.emit('error', { message: 'Not in a room' });
        return;
      }
      
      const room = gameRooms.get(session.currentRoom);
      if (room && room.gameState === 'waiting') {
        room.maxRounds = data.questionCount;
        socket.emit('roomSettingsUpdated', {
          questionCount: room.maxRounds
        });
      }
    } catch (error) {
      console.error('Error updating room settings:', error);
      socket.emit('error', { message: 'Failed to update room settings' });
    }
  });

  // Player ready - removed, game starts automatically when 2 players join

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
      let leaderboard = scoringSystem.getLeaderboard(data.limit || 10);
      
      // Include current game players if they're not in the main leaderboard
      const currentGamePlayers = [];
      for (const [roomId, room] of gameRooms) {
        for (const [playerId, player] of room.players) {
          if (!leaderboard.find(p => p.playerId === playerId)) {
            currentGamePlayers.push({
              playerId,
              totalScore: player.score,
              accuracy: player.accuracy,
              avgResponseTime: player.avgResponseTime,
              performanceTrend: 'stable'
            });
          }
        }
      }
      
      // Combine and sort
      leaderboard = [...leaderboard, ...currentGamePlayers]
        .sort((a, b) => b.totalScore - a.totalScore)
        .slice(0, data.limit || 10);
      
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
      const session = playerSessions.get(playerId);
      let stats = scoringSystem.getPlayerStats(playerId);
      
      // If player is in a room, get current game stats
      if (session && session.currentRoom) {
        const room = gameRooms.get(session.currentRoom);
        if (room && room.players.has(playerId)) {
          const player = room.players.get(playerId);
          stats = {
            ...stats,
            totalScore: player.score,
            recentAccuracy: player.accuracy,
            avgResponseTime: player.avgResponseTime,
            performanceTrend: stats.performanceTrend
          };
        }
      }
      
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


