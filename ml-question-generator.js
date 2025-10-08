const { RandomForestClassifier } = require('ml-random-forest');
const { Matrix } = require('ml-matrix');
const _ = require('lodash');

class MLQuestionGenerator {
  constructor() {
    this.randomForest = new RandomForestClassifier({
      nEstimators: 100,
      maxDepth: 10,
      minSamplesSplit: 2,
      minSamplesLeaf: 1
    });
    
    // Training data for the ML model
    this.trainingData = this.generateTrainingData();
    this.trained = false;
    this.playerPerformanceHistory = new Map();
    this.questionDifficultyHistory = [];
    
    this.trainModel();
  }

  generateTrainingData() {
    const trainingData = [];
    const labels = [];
    
    // Generate synthetic training data based on question characteristics
    // Reduced size to avoid ML library issues
    for (let i = 0; i < 100; i++) {
      const operation = ['+', '-', '*', '/'][Math.floor(Math.random() * 4)];
      const num1 = Math.floor(Math.random() * 100) + 1;
      const num2 = Math.floor(Math.random() * 100) + 1;
      
      // Features: [operation_type, num1, num2, complexity_score, time_taken, accuracy]
      const operationType = ['+', '-', '*', '/'].indexOf(operation);
      const complexity = this.calculateComplexity(num1, num2, operation);
      const timeTaken = Math.random() * 30; // Simulated response time
      const accuracy = Math.random() > 0.3 ? 1 : 0; // Simulated accuracy
      
      trainingData.push([operationType, num1, num2, complexity, timeTaken, accuracy]);
      labels.push(complexity > 0.7 ? 'hard' : complexity > 0.4 ? 'medium' : 'easy');
    }
    
    return { features: trainingData, labels };
  }

  calculateComplexity(num1, num2, operation) {
    let complexity = 0;
    
    // Base complexity by operation
    switch (operation) {
      case '+': complexity = 0.2; break;
      case '-': complexity = 0.3; break;
      case '*': complexity = 0.6; break;
      case '/': complexity = 0.8; break;
    }
    
    // Adjust based on number size
    const maxNum = Math.max(num1, num2);
    if (maxNum > 50) complexity += 0.2;
    if (maxNum > 100) complexity += 0.1;
    
    // Adjust for decimal results in division
    if (operation === '/' && num1 % num2 !== 0) complexity += 0.3;
    
    return Math.min(complexity, 1.0);
  }

  trainModel() {
    try {
      const X = new Matrix(this.trainingData.features);
      this.randomForest.train(X, this.trainingData.labels);
      this.trained = true;
      console.log('ML Question Generator trained successfully');
    } catch (error) {
      console.error('Error training ML model:', error);
      console.log('Falling back to rule-based question generation');
      this.trained = false;
    }
  }

  generateQuestion(playerId, playerStats = {}) {
    if (!this.trained) {
      return this.generateFallbackQuestion();
    }

    try {
      // Get player performance history
      const history = this.playerPerformanceHistory.get(playerId) || {
        accuracy: 0.7,
        avgResponseTime: 15,
        difficultyPreference: 0.5,
        recentAnswers: []
      };

      // Predict optimal difficulty based on player performance
      const features = [
        history.accuracy,
        history.avgResponseTime / 30, // Normalize to 0-1
        history.difficultyPreference,
        Math.random(), // Random factor for variety
        history.recentAnswers.length > 0 ? 
          history.recentAnswers.slice(-5).reduce((a, b) => a + b, 0) / 5 : 0.5
      ];

      const prediction = this.randomForest.predict([features]);
      const targetDifficulty = prediction[0];

      // Generate question based on predicted difficulty
      return this.generateQuestionByDifficulty(targetDifficulty, playerStats);
    } catch (error) {
      console.error('Error generating ML question:', error);
      return this.generateFallbackQuestion();
    }
  }

  generateQuestionByDifficulty(difficulty, playerStats) {
    let operation, num1, num2;
    
    if (difficulty === 'easy') {
      operation = Math.random() > 0.5 ? '+' : '-';
      num1 = Math.floor(Math.random() * 20) + 1;
      num2 = Math.floor(Math.random() * 20) + 1;
    } else if (difficulty === 'medium') {
      operation = ['+', '-', '*'][Math.floor(Math.random() * 3)];
      num1 = Math.floor(Math.random() * 50) + 1;
      num2 = Math.floor(Math.random() * 50) + 1;
    } else { // hard
      operation = ['*', '/', '+', '-'][Math.floor(Math.random() * 4)];
      num1 = Math.floor(Math.random() * 100) + 1;
      num2 = Math.floor(Math.random() * 100) + 1;
    }

    // Ensure division results in whole numbers for easier calculation
    if (operation === '/') {
      num1 = num2 * (Math.floor(Math.random() * 10) + 1);
    }

    const question = `${num1} ${operation} ${num2}`;
    const answer = this.calculateAnswer(num1, num2, operation);
    const complexity = this.calculateComplexity(num1, num2, operation);

    return {
      question,
      answer: answer.toString(),
      complexity,
      difficulty,
      timestamp: Date.now()
    };
  }

  calculateAnswer(num1, num2, operation) {
    switch (operation) {
      case '+': return num1 + num2;
      case '-': return num1 - num2;
      case '*': return num1 * num2;
      case '/': return Math.floor(num1 / num2);
      default: return 0;
    }
  }

  generateFallbackQuestion() {
    const operation = Math.random() > 0.5 ? '+' : '-';
    const num1 = Math.floor(Math.random() * 20) + 1;
    const num2 = Math.floor(Math.random() * 20) + 1;
    const question = `${num1} ${operation} ${num2}`;
    const answer = this.calculateAnswer(num1, num2, operation);

    return {
      question,
      answer: answer.toString(),
      complexity: 0.3,
      difficulty: 'easy',
      timestamp: Date.now()
    };
  }

  updatePlayerPerformance(playerId, question, isCorrect, responseTime) {
    if (!this.playerPerformanceHistory.has(playerId)) {
      this.playerPerformanceHistory.set(playerId, {
        accuracy: 0.7,
        avgResponseTime: 15,
        difficultyPreference: 0.5,
        recentAnswers: []
      });
    }

    const history = this.playerPerformanceHistory.get(playerId);
    
    // Update accuracy (exponential moving average)
    history.accuracy = 0.9 * history.accuracy + 0.1 * (isCorrect ? 1 : 0);
    
    // Update response time
    history.avgResponseTime = 0.9 * history.avgResponseTime + 0.1 * responseTime;
    
    // Update difficulty preference based on performance
    if (isCorrect && responseTime < 10) {
      history.difficultyPreference = Math.min(1.0, history.difficultyPreference + 0.05);
    } else if (!isCorrect || responseTime > 20) {
      history.difficultyPreference = Math.max(0.1, history.difficultyPreference - 0.05);
    }
    
    // Track recent answers
    history.recentAnswers.push(isCorrect ? 1 : 0);
    if (history.recentAnswers.length > 10) {
      history.recentAnswers.shift();
    }

    this.playerPerformanceHistory.set(playerId, history);
    
    // Store question difficulty for model retraining
    this.questionDifficultyHistory.push({
      question,
      difficulty: question.complexity,
      playerAccuracy: history.accuracy,
      responseTime,
      timestamp: Date.now()
    });

    // Keep only last 1000 records
    if (this.questionDifficultyHistory.length > 1000) {
      this.questionDifficultyHistory.shift();
    }
  }

  getPlayerStats(playerId) {
    return this.playerPerformanceHistory.get(playerId) || {
      accuracy: 0.7,
      avgResponseTime: 15,
      difficultyPreference: 0.5,
      recentAnswers: []
    };
  }

  retrainModel() {
    if (this.questionDifficultyHistory.length < 50) return;
    
    try {
      const newTrainingData = this.questionDifficultyHistory.map(record => [
        record.difficulty,
        record.playerAccuracy,
        record.responseTime / 30,
        Math.random(),
        record.timestamp / 1000000 // Normalize timestamp
      ]);
      
      const newLabels = this.questionDifficultyHistory.map(record => 
        record.difficulty > 0.7 ? 'hard' : record.difficulty > 0.4 ? 'medium' : 'easy'
      );
      
      const X = new Matrix(newTrainingData);
      this.randomForest.train(X, newLabels);
      console.log('ML model retrained with new data');
    } catch (error) {
      console.error('Error retraining model:', error);
    }
  }
}

module.exports = MLQuestionGenerator;
