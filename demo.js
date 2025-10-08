#!/usr/bin/env node

/**
 * Demo script to showcase the enhanced math game features
 * This script demonstrates the ML-powered question generation,
 * scoring system, and concurrency management
 */

const MLQuestionGenerator = require('./ml-question-generator');
const ConcurrencyManager = require('./concurrency-manager');
const ScoringSystem = require('./scoring-system');

console.log('🧠 Enhanced Math Race Game - Feature Demo\n');

// Initialize systems
console.log('📊 Initializing systems...');
const mlGenerator = new MLQuestionGenerator();
const concurrencyManager = new ConcurrencyManager();
const scoringSystem = new ScoringSystem();

// Demo 1: ML Question Generation
console.log('\n🤖 Machine Learning Question Generation Demo:');
console.log('=' .repeat(50));

const demoPlayerId = 'demo-player-123';
const playerStats = {
  accuracy: 0.8,
  avgResponseTime: 12,
  difficultyPreference: 0.6
};

// Generate questions with different difficulties
for (let i = 0; i < 5; i++) {
  const question = mlGenerator.generateQuestion(demoPlayerId, playerStats);
  console.log(`Question ${i + 1}: ${question.question} = ?`);
  console.log(`  Difficulty: ${question.difficulty}`);
  console.log(`  Complexity: ${question.complexity.toFixed(2)}`);
  console.log(`  Answer: ${question.answer}\n`);
}

// Demo 2: Scoring System
console.log('\n📊 Sophisticated Scoring System Demo:');
console.log('=' .repeat(50));

// Simulate some answers
const questions = [
  { complexity: 0.3, difficulty: 'easy' },
  { complexity: 0.6, difficulty: 'medium' },
  { complexity: 0.8, difficulty: 'hard' }
];

questions.forEach((question, index) => {
  const isCorrect = Math.random() > 0.2; // 80% accuracy
  const responseTime = 5 + Math.random() * 15; // 5-20 seconds
  
  const score = scoringSystem.calculateScore(
    demoPlayerId,
    question,
    isCorrect,
    responseTime,
    'demo-game'
  );
  
  console.log(`Answer ${index + 1}:`);
  console.log(`  Correct: ${isCorrect}`);
  console.log(`  Response Time: ${responseTime.toFixed(1)}s`);
  console.log(`  Score: ${score} points`);
  console.log(`  Difficulty: ${question.difficulty}\n`);
});

// Get player stats
const finalStats = scoringSystem.getPlayerStats(demoPlayerId);
console.log('Final Player Statistics:');
console.log(`  Total Score: ${finalStats.totalScore}`);
console.log(`  Accuracy: ${(finalStats.recentAccuracy * 100).toFixed(1)}%`);
console.log(`  Avg Response Time: ${finalStats.avgResponseTime.toFixed(1)}s`);
console.log(`  Performance Trend: ${finalStats.performanceTrend}`);

// Demo 3: Concurrency Management
console.log('\n🔒 Concurrency Management Demo:');
console.log('=' .repeat(50));

async function demoConcurrency() {
  console.log('Testing mutex and thread pool...');
  
  // Test mutex
  try {
    const lock = await concurrencyManager.acquireMutex('demo-resource');
    console.log('✅ Mutex acquired successfully');
    
    // Simulate some work
    await new Promise(resolve => setTimeout(resolve, 100));
    
    lock.release();
    console.log('✅ Mutex released successfully');
  } catch (error) {
    console.log('❌ Mutex error:', error.message);
  }
  
  // Test thread pool
  try {
    const result = await concurrencyManager.executeInThread(async () => {
      await new Promise(resolve => setTimeout(resolve, 200));
      return 'Task completed successfully';
    }, 'high');
    
    console.log('✅ Thread pool task:', result);
  } catch (error) {
    console.log('❌ Thread pool error:', error.message);
  }
  
  // Get concurrency stats
  const stats = concurrencyManager.getStats();
  console.log('\nConcurrency Statistics:');
  console.log(`  Active Threads: ${stats.activeThreads}/${stats.maxThreads}`);
  console.log(`  Thread Utilization: ${stats.threadUtilization.toFixed(1)}%`);
  console.log(`  Active Mutexes: ${stats.activeMutexes}`);
  console.log(`  Queued Tasks: ${stats.queuedTasks}`);
}

// Demo 4: Leaderboard
console.log('\n🏆 Leaderboard Demo:');
console.log('=' .repeat(50));

// Add some demo players
const demoPlayers = ['player-1', 'player-2', 'player-3', 'demo-player-123'];
demoPlayers.forEach(playerId => {
  // Generate some random stats
  const randomScore = Math.floor(Math.random() * 1000) + 100;
  const randomAccuracy = 0.5 + Math.random() * 0.4; // 50-90%
  
  // Update player stats
  scoringSystem.updatePlayerStats(playerId, { complexity: 0.5 }, true, 10, randomScore);
  scoringSystem.updatePlayerStats(playerId, { complexity: 0.5 }, true, 8, randomScore);
});

const leaderboard = scoringSystem.getLeaderboard(5);
console.log('Top 5 Players:');
leaderboard.forEach((player, index) => {
  console.log(`  #${index + 1}: ${player.playerId.substring(0, 12)}... - ${player.totalScore} points (${(player.accuracy * 100).toFixed(1)}% accuracy)`);
});

// Demo 5: Analytics
console.log('\n📈 System Analytics:');
console.log('=' .repeat(50));

const analytics = scoringSystem.getAnalytics();
console.log(`Total Players: ${analytics.totalPlayers}`);
console.log(`Total Games: ${analytics.totalGames}`);
console.log(`Average Accuracy: ${(analytics.avgAccuracy * 100).toFixed(1)}%`);
console.log(`Average Response Time: ${analytics.avgResponseTime.toFixed(1)}s`);

// Run concurrency demo
demoConcurrency().then(() => {
  console.log('\n🎉 Demo completed successfully!');
  console.log('\nKey Features Demonstrated:');
  console.log('✅ ML-powered question generation with Random Forest');
  console.log('✅ Sophisticated multi-factor scoring system');
  console.log('✅ Concurrency control with mutex and threading');
  console.log('✅ Real-time leaderboards and analytics');
  console.log('✅ Performance tracking and trend analysis');
  
  console.log('\n🚀 To start the full game server, run:');
  console.log('   node server.js');
  console.log('\n🌐 Then open your browser to:');
  console.log('   http://localhost:3000');
  
  process.exit(0);
}).catch(error => {
  console.error('❌ Demo error:', error);
  process.exit(1);
});
