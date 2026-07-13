"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const express = require("express");
const { Server } = require("socket.io");

const PORT = Number(process.env.PORT || 3000);
const MAX_ROOMS = 5;
const MAX_PLAYERS = 30;
const QUESTION_SECONDS = 25;
const QUESTION_MS = QUESTION_SECONDS * 1000;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

const questionnaires = loadQuestionnaires();
const rooms = new Map();

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/quizzes", (req, res) => {
  res.json({
    title: questionnaires.title,
    quizzes: questionnaires.questionnaires.map((quiz) => ({
      id: String(quiz.questionnaireNumber),
      title: quiz.title,
      topic: quiz.topic,
      questionsCount: quiz.questions.length
    }))
  });
});

app.get("/health", (req, res) => {
  res.json({ ok: true, rooms: rooms.size });
});

io.on("connection", (socket) => {
  socket.on("host:createRoom", (ack) => {
    if (rooms.size >= MAX_ROOMS) {
      return reply(ack, { ok: false, message: "יש כבר 5 חדרים פעילים. סגור חדר אחד ונסה שוב." });
    }

    const code = createRoomCode();
    const room = {
      code,
      hostId: socket.id,
      quizId: null,
      status: "lobby",
      questionIndex: -1,
      questionStartedAt: 0,
      players: new Map(),
      answers: new Map(),
      timer: null,
      createdAt: Date.now()
    };

    rooms.set(code, room);
    socket.join(code);
    socket.data.role = "host";
    socket.data.roomCode = code;
    reply(ack, { ok: true, room: publicRoom(room) });
    emitRoom(code);
  });

  socket.on("host:selectQuiz", ({ code, quizId }, ack) => {
    const room = getHostRoom(socket, code, ack);
    if (!room) return;
    if (room.status !== "lobby") {
      return reply(ack, { ok: false, message: "אי אפשר להחליף שאלון אחרי שהמשחק התחיל." });
    }
    const quiz = findQuiz(quizId);
    if (!quiz) return reply(ack, { ok: false, message: "השאלון לא נמצא." });
    room.quizId = String(quiz.questionnaireNumber);
    reply(ack, { ok: true, room: publicRoom(room) });
    emitRoom(code);
  });

  socket.on("host:startQuiz", ({ code }, ack) => {
    const room = getHostRoom(socket, code, ack);
    if (!room) return;
    if (!room.quizId) return reply(ack, { ok: false, message: "בחר שאלון לפני שמתחילים." });
    if (room.players.size === 0) return reply(ack, { ok: false, message: "צריך לפחות תלמיד אחד בחדר." });
    if (room.status !== "lobby" && room.status !== "finished") {
      return reply(ack, { ok: false, message: "המשחק כבר התחיל." });
    }
    resetScores(room);
    startQuestion(room, 0);
    reply(ack, { ok: true });
  });

  socket.on("host:nextQuestion", ({ code }, ack) => {
    const room = getHostRoom(socket, code, ack);
    if (!room) return;
    const quiz = findQuiz(room.quizId);
    const nextIndex = room.questionIndex + 1;
    if (nextIndex >= quiz.questions.length) {
      finishQuiz(room);
    } else {
      startQuestion(room, nextIndex);
    }
    reply(ack, { ok: true });
  });

  socket.on("host:showPodium", ({ code }, ack) => {
    const room = getHostRoom(socket, code, ack);
    if (!room) return;
    room.status = "podium";
    clearRoomTimer(room);
    emitRoom(code);
    reply(ack, { ok: true });
  });

  socket.on("host:resetRoom", ({ code }, ack) => {
    const room = getHostRoom(socket, code, ack);
    if (!room) return;
    clearRoomTimer(room);
    room.status = "lobby";
    room.questionIndex = -1;
    room.questionStartedAt = 0;
    room.answers.clear();
    resetScores(room);
    emitRoom(code);
    reply(ack, { ok: true });
  });

  socket.on("host:closeRoom", ({ code }, ack) => {
    const room = getHostRoom(socket, code, ack);
    if (!room) return;
    clearRoomTimer(room);
    io.to(code).emit("room:closed");
    rooms.delete(code);
    reply(ack, { ok: true });
  });

  socket.on("player:join", ({ code, name }, ack) => {
    const room = rooms.get(String(code || "").trim());
    if (!room) return reply(ack, { ok: false, message: "לא מצאתי חדר עם הקוד הזה." });
    if (room.status !== "lobby") return reply(ack, { ok: false, message: "החידון כבר התחיל. חכה לחדר חדש." });
    if (room.players.size >= MAX_PLAYERS) return reply(ack, { ok: false, message: "החדר מלא." });

    const cleanName = cleanPlayerName(name);
    const player = {
      id: socket.id,
      name: cleanName,
      score: 0,
      connected: true,
      joinedAt: Date.now(),
      lastAnswer: null
    };

    room.players.set(socket.id, player);
    socket.join(room.code);
    socket.data.role = "player";
    socket.data.roomCode = room.code;
    reply(ack, { ok: true, room: playerRoom(room, socket.id), player });
    emitRoom(room.code);
  });

  socket.on("player:answer", ({ code, answerIndex }, ack) => {
    const room = rooms.get(String(code || ""));
    if (!room || socket.data.roomCode !== room.code) {
      return reply(ack, { ok: false, message: "החדר לא נמצא." });
    }
    const player = room.players.get(socket.id);
    if (!player) return reply(ack, { ok: false, message: "לא מצאתי את השחקן בחדר." });
    if (room.status !== "question") return reply(ack, { ok: false, message: "עכשיו לא זמן לענות." });
    if (room.answers.has(socket.id)) return reply(ack, { ok: false, message: "כבר ענית על השאלה הזאת." });

    const quiz = findQuiz(room.quizId);
    const question = quiz.questions[room.questionIndex];
    const options = getOptions(question);
    const now = Date.now();
    const responseMs = Math.max(0, Math.min(QUESTION_MS, now - room.questionStartedAt));
    const index = Number(answerIndex);
    const selected = options[index];
    const correct = selected === question.correctAnswer;
    const score = correct ? Math.max(250, Math.round(1000 * (1 - responseMs / QUESTION_MS))) : 0;

    player.score += score;
    player.lastAnswer = { correct, score, responseMs };
    room.answers.set(socket.id, {
      playerId: socket.id,
      answerIndex: index,
      answerText: selected,
      correct,
      score,
      responseMs
    });

    reply(ack, { ok: true, correct, score });
    io.to(socket.id).emit("player:answered", { correct, score });
    emitRoom(room.code);

    if (allConnectedPlayersAnswered(room)) {
      showResults(room);
    }
  });

  socket.on("disconnect", () => {
    const { role, roomCode } = socket.data;
    if (!roomCode) return;
    const room = rooms.get(roomCode);
    if (!room) return;

    if (role === "host" && room.hostId === socket.id) {
      clearRoomTimer(room);
      io.to(roomCode).emit("room:closed");
      rooms.delete(roomCode);
      return;
    }

    if (role === "player" && room.players.has(socket.id)) {
      const player = room.players.get(socket.id);
      player.connected = false;
      emitRoom(roomCode);
    }
  });
});

function loadQuestionnaires() {
  const filePath = path.join(__dirname, "data", "questionnaires.json");
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function findQuiz(quizId) {
  return questionnaires.questionnaires.find((quiz) => String(quiz.questionnaireNumber) === String(quizId));
}

function createRoomCode() {
  for (let i = 0; i < 100; i += 1) {
    const code = String(Math.floor(1000 + Math.random() * 9000));
    if (!rooms.has(code)) return code;
  }
  throw new Error("Unable to create room code");
}

function startQuestion(room, index) {
  const quiz = findQuiz(room.quizId);
  room.status = "question";
  room.questionIndex = index;
  room.questionStartedAt = Date.now();
  room.answers.clear();
  for (const player of room.players.values()) {
    player.lastAnswer = null;
  }
  clearRoomTimer(room);
  room.timer = setTimeout(() => showResults(room), QUESTION_MS + 250);
  emitQuestion(room, quiz.questions[index]);
  emitRoom(room.code);
}

function showResults(room) {
  if (room.status !== "question") return;
  clearRoomTimer(room);
  room.status = "results";
  const quiz = findQuiz(room.quizId);
  const question = quiz.questions[room.questionIndex];
  io.to(room.code).emit("quiz:results", {
    room: publicRoom(room),
    result: questionResult(room, question)
  });
}

function finishQuiz(room) {
  room.status = "finished";
  clearRoomTimer(room);
  emitRoom(room.code);
}

function emitQuestion(room, question) {
  const payload = {
    room: publicRoom(room),
    question: publicQuestion(room, question),
    seconds: QUESTION_SECONDS
  };
  io.to(room.code).emit("quiz:question", payload);
}

function emitRoom(code) {
  const room = rooms.get(code);
  if (!room) return;
  io.to(room.hostId).emit("room:update", { room: publicRoom(room) });
  for (const player of room.players.values()) {
    io.to(player.id).emit("room:update", { room: playerRoom(room, player.id) });
  }
}

function publicRoom(room) {
  const quiz = room.quizId ? findQuiz(room.quizId) : null;
  return {
    code: room.code,
    status: room.status,
    quizId: room.quizId,
    quizTitle: quiz ? quiz.title : null,
    questionIndex: room.questionIndex,
    totalQuestions: quiz ? quiz.questions.length : 0,
    answerCount: room.answers.size,
    players: leaderboard(room),
    podium: podium(room)
  };
}

function playerRoom(room, playerId) {
  const base = publicRoom(room);
  const player = room.players.get(playerId);
  return {
    ...base,
    me: player ? {
      id: player.id,
      name: player.name,
      score: player.score,
      lastAnswer: player.lastAnswer
    } : null
  };
}

function publicQuestion(room, question) {
  return {
    questionNumber: question.questionNumber,
    totalQuestions: findQuiz(room.quizId).questions.length,
    text: question.question,
    options: getOptions(question),
    startedAt: room.questionStartedAt,
    durationMs: QUESTION_MS
  };
}

function questionResult(room, question) {
  const options = getOptions(question);
  const counts = options.map((text, index) => ({
    index,
    text,
    count: 0,
    correct: text === question.correctAnswer
  }));

  for (const answer of room.answers.values()) {
    if (counts[answer.answerIndex]) counts[answer.answerIndex].count += 1;
  }

  return {
    correctAnswer: question.correctAnswer,
    options: counts,
    leaderboard: leaderboard(room).slice(0, 5)
  };
}

function getOptions(question) {
  return [question.answer1, question.answer2, question.answer3, question.answer4];
}

function leaderboard(room) {
  return Array.from(room.players.values())
    .map((player) => ({
      id: player.id,
      name: player.name,
      score: player.score,
      connected: player.connected,
      lastAnswer: player.lastAnswer
    }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, "he"));
}

function podium(room) {
  return leaderboard(room).slice(0, 3);
}

function resetScores(room) {
  for (const player of room.players.values()) {
    player.score = 0;
    player.lastAnswer = null;
  }
}

function allConnectedPlayersAnswered(room) {
  const connected = Array.from(room.players.values()).filter((player) => player.connected);
  return connected.length > 0 && connected.every((player) => room.answers.has(player.id));
}

function clearRoomTimer(room) {
  if (room.timer) clearTimeout(room.timer);
  room.timer = null;
}

function getHostRoom(socket, code, ack) {
  const room = rooms.get(String(code || ""));
  if (!room) {
    reply(ack, { ok: false, message: "החדר לא נמצא." });
    return null;
  }
  if (room.hostId !== socket.id) {
    reply(ack, { ok: false, message: "רק המדריך שיצר את החדר יכול לשלוט בו." });
    return null;
  }
  return room;
}

function cleanPlayerName(name) {
  const text = String(name || "").trim().replace(/\s+/g, " ");
  if (!text) return "סוכן בלי שם";
  return text.slice(0, 18);
}

function reply(ack, payload) {
  if (typeof ack === "function") ack(payload);
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Digitolia live quiz is running on http://localhost:${PORT}`);
});
