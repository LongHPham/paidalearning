const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

// Store player data
let playerData = {};

function generateMathQuestion() {
  const operation = Math.random() > 0.5 ? '+' : '-';
  const num1 = Math.floor(Math.random() * 20) + 1; // numbers between 1 and 20
  const num2 = Math.floor(Math.random() * 20) + 1;
  const question = `${num1} ${operation} ${num2}`;
  const answer = eval(question);
  return { question, answer: answer.toString() }; // Ensure answer is stored as a string for comparison
}

io.on('connection', (socket) => {
  console.log('A user connected');

  // Assign a unique ID to each connection for demonstration purposes
  // In a real app, this could be a user ID or session ID
  const playerId = socket.id;
  const { question, answer } = generateMathQuestion();
  playerData[playerId] = { question, answer };

  socket.emit('newQuestion', { question });

  socket.on('submitAnswer', (data) => {
    const playerAnswer = data.answer;
    const correctAnswer = playerData[playerId].answer;

    if (playerAnswer === correctAnswer) {
      console.log(`Player ${playerId} answered correctly!`);
      io.emit('progressUpdate', { correct: true, player: playerId });
      const newQuestion = generateMathQuestion();
      playerData[playerId] = { question: newQuestion.question, answer: newQuestion.answer };
      socket.emit('newQuestion', { question: newQuestion.question });
    } else {
      console.log(`Player ${playerId} answered incorrectly.`);
      socket.emit('progressUpdate', { correct: false, player: playerId });
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected');
    delete playerData[playerId]; // Clean up player data when they disconnect
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});


