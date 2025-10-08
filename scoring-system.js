const _ = require('lodash');

class ScoringSystem {
  constructor() {
    this.playerScores = new Map();
    this.gameHistory = new Map();
    this.accuracyMetrics = new Map();
    this.difficultyAdjustments = new Map();
    this.performanceTrends = new Map();
    
    // Scoring weights
    this.weights = {
      accuracy: 0.4,
      speed: 0.3,
      consistency: 0.2,
      difficulty: 0.1
    };
    
    // Base scoring parameters
    this.baseScore = 100;
    this.speedBonus = 50;
    this.accuracyBonus = 75;
    this.difficultyMultiplier = 1.5;
  }

  // Calculate comprehensive score for a player's answer
  calculateScore(playerId, question, isCorrect, responseTime, gameId) {
    const playerStats = this.getPlayerStats(playerId);
    const questionDifficulty = question.complexity || 0.5;
    
    let score = 0;
    
    if (isCorrect) {
      // Base score for correct answer
      score = this.baseScore;
      
      // Speed bonus (faster = higher bonus)
      const optimalTime = this.getOptimalTime(questionDifficulty);
      if (responseTime <= optimalTime) {
        const speedRatio = optimalTime / responseTime;
        score += this.speedBonus * Math.min(speedRatio, 2.0); // Cap at 2x bonus
      }
      
      // Accuracy bonus based on recent performance
      const accuracyBonus = this.calculateAccuracyBonus(playerId);
      score += this.accuracyBonus * accuracyBonus;
      
      // Difficulty multiplier
      score *= (1 + questionDifficulty * this.difficultyMultiplier);
      
      // Consistency bonus
      const consistencyBonus = this.calculateConsistencyBonus(playerId);
      score *= (1 + consistencyBonus);
      
    } else {
      // Penalty for incorrect answer
      score = -this.baseScore * 0.3;
      
      // Additional penalty for very fast wrong answers (guessing)
      if (responseTime < 2) {
        score -= this.baseScore * 0.2;
      }
    }
    
    // Update player statistics
    this.updatePlayerStats(playerId, question, isCorrect, responseTime, score);
    this.updateGameHistory(gameId, playerId, score);
    
    return Math.round(score);
  }

  getOptimalTime(difficulty) {
    // Optimal response times based on difficulty
    const baseTime = 10; // 10 seconds base
    const difficultyTime = difficulty * 15; // Up to 15 additional seconds
    return baseTime + difficultyTime;
  }

  calculateAccuracyBonus(playerId) {
    const stats = this.getPlayerStats(playerId);
    const recentAccuracy = stats.recentAccuracy || 0.7;
    
    // Bonus increases with higher accuracy
    return Math.max(0, (recentAccuracy - 0.5) * 2);
  }

  calculateConsistencyBonus(playerId) {
    const stats = this.getPlayerStats(playerId);
    const recentScores = stats.recentScores || [];
    
    if (recentScores.length < 3) return 0;
    
    // Calculate coefficient of variation (lower = more consistent)
    const mean = _.mean(recentScores);
    const variance = _.mean(recentScores.map(score => Math.pow(score - mean, 2)));
    const stdDev = Math.sqrt(variance);
    const coefficient = stdDev / Math.abs(mean);
    
    // Bonus for consistency (lower coefficient = higher bonus)
    return Math.max(0, 0.3 - coefficient);
  }

  updatePlayerStats(playerId, question, isCorrect, responseTime, score) {
    if (!this.playerScores.has(playerId)) {
      this.playerScores.set(playerId, {
        totalScore: 0,
        correctAnswers: 0,
        totalAnswers: 0,
        avgResponseTime: 0,
        recentAccuracy: 0.7,
        recentScores: [],
        difficultyHistory: [],
        performanceTrend: 'stable'
      });
    }
    
    const stats = this.playerScores.get(playerId);
    
    // Update basic stats
    stats.totalScore += score;
    stats.totalAnswers++;
    if (isCorrect) stats.correctAnswers++;
    
    // Update response time (exponential moving average)
    stats.avgResponseTime = 0.9 * stats.avgResponseTime + 0.1 * responseTime;
    
    // Update recent accuracy (last 10 answers)
    const recentAnswers = this.getRecentAnswers(playerId, 10);
    recentAnswers.push(isCorrect);
    stats.recentAccuracy = recentAnswers.reduce((sum, correct) => sum + (correct ? 1 : 0), 0) / recentAnswers.length;
    
    // Update recent scores
    stats.recentScores.push(score);
    if (stats.recentScores.length > 10) {
      stats.recentScores.shift();
    }
    
    // Update difficulty history
    stats.difficultyHistory.push({
      difficulty: question.complexity,
      correct: isCorrect,
      timestamp: Date.now()
    });
    if (stats.difficultyHistory.length > 20) {
      stats.difficultyHistory.shift();
    }
    
    // Calculate performance trend
    stats.performanceTrend = this.calculatePerformanceTrend(playerId);
    
    this.playerScores.set(playerId, stats);
  }

  getRecentAnswers(playerId, count) {
    const stats = this.playerScores.get(playerId);
    if (!stats || !stats.difficultyHistory) return [];
    
    return stats.difficultyHistory
      .slice(-count)
      .map(record => record.correct);
  }

  calculatePerformanceTrend(playerId) {
    const stats = this.playerScores.get(playerId);
    if (!stats || stats.recentScores.length < 5) return 'stable';
    
    const recentScores = stats.recentScores.slice(-5);
    const olderScores = stats.recentScores.slice(-10, -5);
    
    if (olderScores.length === 0) return 'stable';
    
    const recentAvg = _.mean(recentScores);
    const olderAvg = _.mean(olderScores);
    
    const improvement = (recentAvg - olderAvg) / Math.abs(olderAvg);
    
    if (improvement > 0.1) return 'improving';
    if (improvement < -0.1) return 'declining';
    return 'stable';
  }

  updateGameHistory(gameId, playerId, score) {
    if (!this.gameHistory.has(gameId)) {
      this.gameHistory.set(gameId, {
        players: new Map(),
        startTime: Date.now(),
        totalQuestions: 0
      });
    }
    
    const game = this.gameHistory.get(gameId);
    
    if (!game.players.has(playerId)) {
      game.players.set(playerId, {
        totalScore: 0,
        questionsAnswered: 0,
        correctAnswers: 0,
        avgResponseTime: 0
      });
    }
    
    const playerGameStats = game.players.get(playerId);
    playerGameStats.totalScore += score;
    playerGameStats.questionsAnswered++;
    
    this.gameHistory.set(gameId, game);
  }

  getPlayerStats(playerId) {
    return this.playerScores.get(playerId) || {
      totalScore: 0,
      correctAnswers: 0,
      totalAnswers: 0,
      avgResponseTime: 0,
      recentAccuracy: 0.7,
      recentScores: [],
      difficultyHistory: [],
      performanceTrend: 'stable'
    };
  }

  getGameStats(gameId) {
    const game = this.gameHistory.get(gameId);
    if (!game) return null;
    
    const players = Array.from(game.players.entries()).map(([playerId, stats]) => ({
      playerId,
      ...stats,
      accuracy: stats.correctAnswers / stats.questionsAnswered || 0
    }));
    
    return {
      gameId,
      players,
      duration: Date.now() - game.startTime,
      totalQuestions: game.totalQuestions
    };
  }

  // Generate leaderboard
  getLeaderboard(limit = 10) {
    const players = Array.from(this.playerScores.entries())
      .map(([playerId, stats]) => ({
        playerId,
        totalScore: stats.totalScore,
        accuracy: stats.correctAnswers / stats.totalAnswers || 0,
        avgResponseTime: stats.avgResponseTime,
        performanceTrend: stats.performanceTrend
      }))
      .sort((a, b) => b.totalScore - a.totalScore)
      .slice(0, limit);
    
    return players;
  }

  // Calculate difficulty adjustment for ML system
  getDifficultyAdjustment(playerId) {
    const stats = this.getPlayerStats(playerId);
    
    // Base adjustment on recent performance
    let adjustment = 0;
    
    if (stats.recentAccuracy > 0.8) {
      adjustment = 0.2; // Increase difficulty
    } else if (stats.recentAccuracy < 0.5) {
      adjustment = -0.2; // Decrease difficulty
    }
    
    // Adjust based on response time
    if (stats.avgResponseTime < 8) {
      adjustment += 0.1; // Faster responses = increase difficulty
    } else if (stats.avgResponseTime > 20) {
      adjustment -= 0.1; // Slower responses = decrease difficulty
    }
    
    // Adjust based on performance trend
    if (stats.performanceTrend === 'improving') {
      adjustment += 0.1;
    } else if (stats.performanceTrend === 'declining') {
      adjustment -= 0.1;
    }
    
    return Math.max(-0.5, Math.min(0.5, adjustment));
  }

  // Calculate satisfaction score (for ML feedback)
  calculateSatisfactionScore(playerId) {
    const stats = this.getPlayerStats(playerId);
    
    // Factors that contribute to satisfaction
    const accuracySatisfaction = stats.recentAccuracy;
    const speedSatisfaction = Math.max(0, 1 - (stats.avgResponseTime - 10) / 20);
    const progressSatisfaction = stats.performanceTrend === 'improving' ? 1 : 
                                stats.performanceTrend === 'stable' ? 0.7 : 0.4;
    
    // Weighted satisfaction score
    const satisfaction = (
      accuracySatisfaction * 0.4 +
      speedSatisfaction * 0.3 +
      progressSatisfaction * 0.3
    );
    
    return Math.max(0, Math.min(1, satisfaction));
  }

  // Reset player stats (for new games)
  resetPlayerStats(playerId) {
    this.playerScores.delete(playerId);
  }

  // Get comprehensive analytics
  getAnalytics() {
    const totalPlayers = this.playerScores.size;
    const totalGames = this.gameHistory.size;
    
    const avgAccuracy = Array.from(this.playerScores.values())
      .reduce((sum, stats) => sum + (stats.correctAnswers / stats.totalAnswers || 0), 0) / totalPlayers;
    
    const avgResponseTime = Array.from(this.playerScores.values())
      .reduce((sum, stats) => sum + stats.avgResponseTime, 0) / totalPlayers;
    
    return {
      totalPlayers,
      totalGames,
      avgAccuracy: avgAccuracy || 0,
      avgResponseTime: avgResponseTime || 0,
      leaderboard: this.getLeaderboard(5)
    };
  }
}

module.exports = ScoringSystem;
