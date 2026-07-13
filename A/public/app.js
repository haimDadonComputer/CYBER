"use strict";

const socket = io();
const app = document.getElementById("app");

const state = {
  mode: "home",
  quizzes: [],
  room: null,
  question: null,
  result: null,
  playerAnswered: false,
  podiumStep: 0,
  timerFrame: null
};

const answerClasses = ["red", "blue", "yellow", "green"];

init();

async function init() {
  const response = await fetch("/api/quizzes");
  const data = await response.json();
  state.quizzes = data.quizzes;
  bindSocketEvents();
  renderHome();
}

function bindSocketEvents() {
  socket.on("room:update", ({ room }) => {
    state.room = room;
    if (state.mode !== "home") render();
  });

  socket.on("quiz:question", ({ room, question }) => {
    state.room = room;
    state.question = question;
    state.result = null;
    state.playerAnswered = false;
    render();
  });

  socket.on("quiz:results", ({ room, result }) => {
    state.room = room;
    state.result = result;
    state.question = null;
    state.playerAnswered = false;
    render();
  });

  socket.on("player:answered", ({ correct, score }) => {
    state.playerAnswered = true;
    showToast(correct ? `תשובה נכונה! קיבלת ${score} נקודות` : "הפעם זה לא היה נכון. ממשיכים.");
    render();
  });

  socket.on("room:closed", () => {
    state.mode = "home";
    state.room = null;
    state.question = null;
    state.result = null;
    showToast("החדר נסגר.");
    renderHome();
  });
}

function render() {
  cancelTimer();
  if (state.mode === "host") renderHost();
  if (state.mode === "player") renderPlayer();
}

function renderHome() {
  cancelTimer();
  app.innerHTML = `
    <main class="home">
      <section class="home-panel">
        <div class="home-hero">
          <div class="brand">
            <span class="brand-mark"></span>
            <div>
              <strong>דיגיטוליה Live</strong>
              <small>חידון סייבר בזמן אמת</small>
            </div>
          </div>
          <h1>מי הסוכן הכי חד בעיר?</h1>
          <p>המדריך פותח חדר, התלמידים נכנסים עם קוד, וכולם עונים יחד על שאלות מתוך משימות דיגיטוליה.</p>
        </div>
        <div class="home-actions">
          <button class="role-card host" id="hostBtn" type="button">
            <strong>אני המדריך</strong>
            <span>יצירת חדר ובחירת שאלון</span>
          </button>
          <button class="role-card player" id="playerBtn" type="button">
            <strong>אני תלמיד</strong>
            <span>כניסה עם קוד בן 4 ספרות</span>
          </button>
        </div>
      </section>
    </main>
  `;
  document.getElementById("hostBtn").addEventListener("click", createHostRoom);
  document.getElementById("playerBtn").addEventListener("click", renderJoin);
}

function renderJoin() {
  state.mode = "join";
  app.innerHTML = `
    <main class="home">
      <section class="panel">
        <div class="brand">
          <span class="brand-mark"></span>
          <div>
            <strong>כניסה לחדר</strong>
            <small>הקוד מופיע אצל המדריך</small>
          </div>
        </div>
        <form class="form-grid" id="joinForm">
          <label class="field">
            שם הסוכן
            <input id="playerName" maxlength="18" autocomplete="name" placeholder="לדוגמה: נועם">
          </label>
          <label class="field">
            קוד חדר
            <input id="roomCode" inputmode="numeric" maxlength="4" autocomplete="one-time-code" placeholder="1234">
          </label>
          <button class="primary-button" type="submit">כניסה למשחק</button>
          <button class="secondary-button" id="backHome" type="button">חזרה</button>
        </form>
      </section>
    </main>
  `;

  document.getElementById("backHome").addEventListener("click", renderHome);
  document.getElementById("joinForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const name = document.getElementById("playerName").value;
    const code = document.getElementById("roomCode").value.replace(/\D/g, "");
    socket.emit("player:join", { code, name }, (response) => {
      if (!response.ok) return showToast(response.message);
      state.mode = "player";
      state.room = response.room;
      renderPlayer();
    });
  });
}

function createHostRoom() {
  socket.emit("host:createRoom", (response) => {
    if (!response.ok) return showToast(response.message);
    state.mode = "host";
    state.room = response.room;
    renderHost();
  });
}

function renderHost() {
  if (!state.room) return renderHome();
  if (state.room.status === "question" && state.question) return renderHostQuestion();
  if (state.room.status === "results" && state.result) return renderHostResults();
  if (state.room.status === "podium") return renderPodium();
  if (state.room.status === "finished") return renderHostFinished();
  renderHostLobby();
}

function renderHostLobby() {
  const room = state.room;
  app.innerHTML = screenLayout(`
    <div class="content grid-two">
      <section>
        <div class="room-code">
          <div>
            <small>קוד החדר</small>
            <strong>${room.code}</strong>
          </div>
        </div>
        <p class="join-url">${location.origin}</p>
      </section>
      <section class="panel">
        <h2>בחירת שאלון</h2>
        <div class="form-grid">
          <label class="field">
            שאלון למשחק
            <select id="quizSelect">
              <option value="">בחר שאלון</option>
              ${state.quizzes.map((quiz) => `
                <option value="${quiz.id}" ${room.quizId === quiz.id ? "selected" : ""}>
                  ${escapeHtml(quiz.title)} (${quiz.questionsCount} שאלות)
                </option>
              `).join("")}
            </select>
          </label>
          <button class="primary-button" id="startBtn" type="button" ${!room.quizId || room.players.length === 0 ? "disabled" : ""}>התחל שאלון</button>
          <button class="danger-button" id="closeBtn" type="button">סגור חדר</button>
        </div>
        <h3>תלמידים בחדר: ${room.players.length}/${30}</h3>
        <div class="players-list">${playersHtml(room.players)}</div>
      </section>
    </div>
  `, "מסך מדריך", room.code);

  document.getElementById("quizSelect").addEventListener("change", (event) => {
    socket.emit("host:selectQuiz", { code: room.code, quizId: event.target.value }, handleAck);
  });
  document.getElementById("startBtn").addEventListener("click", () => {
    socket.emit("host:startQuiz", { code: room.code }, handleAck);
  });
  document.getElementById("closeBtn").addEventListener("click", () => {
    socket.emit("host:closeRoom", { code: room.code }, handleAck);
  });
}

function renderHostQuestion() {
  const room = state.room;
  const question = state.question;
  app.innerHTML = screenLayout(`
    <div class="content quiz-stage">
      ${timerHtml(question)}
      <section class="question-card">
        <div class="pill">שאלה ${room.questionIndex + 1} מתוך ${room.totalQuestions}</div>
        <h1>${escapeHtml(question.text)}</h1>
        <strong>${room.answerCount}/${room.players.length} ענו</strong>
      </section>
      <section class="answers-grid">${answersHtml(question.options, true)}</section>
    </div>
  `, room.quizTitle || "שאלון פעיל", `${room.answerCount}/${room.players.length} ענו`);
  startTimer(question);
}

function renderHostResults() {
  const room = state.room;
  const result = state.result;
  app.innerHTML = screenLayout(`
    <div class="content grid-two">
      <section class="panel">
        <h2>התשובה הנכונה</h2>
        <p class="big-answer">${escapeHtml(result.correctAnswer)}</p>
        <div class="results-grid">
          ${result.options.map((option) => resultBarHtml(option, room.players.length)).join("")}
        </div>
      </section>
      <section class="panel">
        <h2>מובילים כרגע</h2>
        <div class="leaderboard">${leaderboardHtml(room.players.slice(0, 5))}</div>
        <button class="primary-button" id="nextQuestionBtn" type="button">
          ${room.questionIndex + 1 >= room.totalQuestions ? "סיים והצג מנצחים" : "לשאלה הבאה"}
        </button>
      </section>
    </div>
  `, "תוצאות השאלה", `שאלה ${room.questionIndex + 1}`);
  requestAnimationFrame(() => {
    document.querySelectorAll(".bar-fill").forEach((bar) => {
      bar.style.width = bar.dataset.width;
    });
  });
  document.getElementById("nextQuestionBtn").addEventListener("click", () => {
    socket.emit("host:nextQuestion", { code: room.code }, handleAck);
  });
}

function renderHostFinished() {
  const room = state.room;
  app.innerHTML = screenLayout(`
    <div class="content grid-two">
      <section class="status-card panel">
        <div>
          <h1>החידון נגמר</h1>
          <p>מוכנים לגלות את שלושת המקומות הראשונים?</p>
          <button class="primary-button" id="showPodiumBtn" type="button">הצג פודיום</button>
        </div>
      </section>
      <section class="panel">
        <h2>הדירוג שמור, אבל הפודיום מגיע קודם</h2>
        <div class="leaderboard">${leaderboardHtml(room.players)}</div>
      </section>
    </div>
  `, "סיום", room.code);
  document.getElementById("showPodiumBtn").addEventListener("click", () => {
    state.podiumStep = 0;
    socket.emit("host:showPodium", { code: room.code }, handleAck);
  });
}

function renderPodium() {
  const room = state.room;
  const podium = [...room.podium].reverse();
  const current = podium[state.podiumStep];
  app.innerHTML = screenLayout(`
    <div class="content">
      <section class="podium">
        ${current ? `
          <div class="podium-card show">
            <div class="podium-place">מקום ${3 - state.podiumStep}</div>
            <div class="podium-name">${escapeHtml(current.name)}</div>
            <div class="podium-score">${current.score} נקודות</div>
          </div>
        ` : `
          <div class="panel">
            <h2>טבלת המקומות</h2>
            <div class="final-list">${leaderboardHtml(room.players)}</div>
            <button class="secondary-button" id="resetRoomBtn" type="button">חזרה ללובי</button>
          </div>
        `}
      </section>
    </div>
  `, "פודיום", room.code);

  if (current) {
    setTimeout(() => {
      state.podiumStep += 1;
      renderPodium();
    }, 2300);
  } else {
    document.getElementById("resetRoomBtn").addEventListener("click", () => {
      socket.emit("host:resetRoom", { code: room.code }, handleAck);
    });
  }
}

function renderPlayer() {
  if (!state.room) return renderHome();
  if (state.room.status === "question" && state.question) return renderPlayerQuestion();
  if (state.room.status === "results") return renderPlayerResults();
  if (state.room.status === "finished" || state.room.status === "podium") return renderPlayerFinished();
  renderPlayerLobby();
}

function renderPlayerLobby() {
  const room = state.room;
  app.innerHTML = screenLayout(`
    <div class="content">
      <section class="status-card panel">
        <div>
          <h1>נכנסת לחדר ${room.code}</h1>
          <p>${escapeHtml(room.me.name)}, מחכים שהמדריך יתחיל את החידון.</p>
          <div class="pill">${room.me.score} נקודות</div>
        </div>
      </section>
    </div>
  `, "מסך תלמיד", room.code);
}

function renderPlayerQuestion() {
  const question = state.question;
  app.innerHTML = screenLayout(`
    <div class="content quiz-stage">
      ${timerHtml(question)}
      <section class="question-card">
        <div class="pill">שאלה ${question.questionNumber} מתוך ${question.totalQuestions}</div>
        <h1>${escapeHtml(question.text)}</h1>
      </section>
      <section class="answers-grid">${answersHtml(question.options, false)}</section>
    </div>
  `, state.room.me.name, `${state.room.me.score} נקודות`);
  document.querySelectorAll(".answer-card").forEach((button) => {
    button.addEventListener("click", () => sendAnswer(Number(button.dataset.index)));
  });
  if (state.playerAnswered) markAnswered();
  startTimer(question);
}

function renderPlayerResults() {
  const last = state.room.me.lastAnswer;
  app.innerHTML = screenLayout(`
    <div class="content">
      <section class="status-card panel">
        <div>
          <h1>${last && last.correct ? "נכון!" : "ממשיכים"}</h1>
          <p>${last ? `קיבלת ${last.score} נקודות בשאלה הזאת` : "לא נרשמה תשובה לשאלה הזאת"}</p>
          <div class="pill">סה״כ ${state.room.me.score} נקודות</div>
        </div>
      </section>
    </div>
  `, state.room.me.name, `${state.room.me.score} נקודות`);
}

function renderPlayerFinished() {
  const room = state.room;
  const myPlace = room.players.findIndex((player) => player.id === room.me.id) + 1;
  app.innerHTML = screenLayout(`
    <div class="content">
      <section class="status-card panel">
        <div>
          <h1>כל הכבוד!</h1>
          <p>סיימת במקום ${myPlace || "-"} עם ${room.me.score} נקודות.</p>
          <div class="leaderboard">${leaderboardHtml(room.players)}</div>
        </div>
      </section>
    </div>
  `, room.me.name, `${room.me.score} נקודות`);
}

function sendAnswer(index) {
  if (state.playerAnswered) return;
  state.playerAnswered = true;
  document.querySelectorAll(".answer-card").forEach((button) => {
    button.disabled = true;
    if (Number(button.dataset.index) === index) button.classList.add("selected");
  });
  socket.emit("player:answer", { code: state.room.code, answerIndex: index }, handleAck);
}

function markAnswered() {
  document.querySelectorAll(".answer-card").forEach((button) => {
    button.disabled = true;
  });
}

function screenLayout(content, title, badge) {
  return `
    <main class="screen">
      <header class="topbar">
        <div class="brand">
          <span class="brand-mark"></span>
          <div>
            <strong>${escapeHtml(title)}</strong>
            <small>דיגיטוליה Live Quiz</small>
          </div>
        </div>
        <span class="pill">${escapeHtml(String(badge || ""))}</span>
      </header>
      ${content}
    </main>
  `;
}

function answersHtml(options, disabled) {
  return options.map((text, index) => `
    <button class="answer-card ${answerClasses[index]}" data-index="${index}" type="button" ${disabled ? "disabled" : ""}>
      <span class="answer-icon"></span>
      <span class="answer-text">${escapeHtml(text)}</span>
    </button>
  `).join("");
}

function playersHtml(players) {
  if (!players.length) return `<p class="muted">מחכים לתלמידים...</p>`;
  return players.map((player) => `
    <div class="player-row">
      <span class="player-dot ${player.connected ? "" : "offline"}"></span>
      <span>${escapeHtml(player.name)}</span>
      <strong>${player.score}</strong>
    </div>
  `).join("");
}

function leaderboardHtml(players) {
  if (!players.length) return `<p class="muted">אין עדיין משתתפים.</p>`;
  return players.map((player, index) => `
    <div class="leader-row">
      <strong>${index + 1}</strong>
      <span>${escapeHtml(player.name)}</span>
      <strong>${player.score}</strong>
    </div>
  `).join("");
}

function resultBarHtml(option, totalPlayers) {
  const percent = totalPlayers ? Math.round((option.count / totalPlayers) * 100) : 0;
  return `
    <div class="result-bar">
      <div>
        <strong>${escapeHtml(option.text)}</strong>
        <div class="bar-track">
          <div class="bar-fill ${option.correct ? "correct" : ""}" data-width="${percent}%"></div>
        </div>
      </div>
      <span class="bar-label">${option.count}</span>
    </div>
  `;
}

function timerHtml(question) {
  return `
    <div class="timer-line" aria-label="זמן לשאלה">
      <div class="timer-fill" id="timerFill"></div>
    </div>
  `;
}

function startTimer(question) {
  const fill = document.getElementById("timerFill");
  if (!fill) return;
  const tick = () => {
    const elapsed = Date.now() - question.startedAt;
    const ratio = Math.max(0, 1 - elapsed / question.durationMs);
    fill.style.transform = `scaleX(${ratio})`;
    if (ratio > 0) state.timerFrame = requestAnimationFrame(tick);
  };
  tick();
}

function cancelTimer() {
  if (state.timerFrame) cancelAnimationFrame(state.timerFrame);
  state.timerFrame = null;
}

function handleAck(response) {
  if (response && !response.ok) showToast(response.message || "משהו לא הצליח.");
}

function showToast(message) {
  const oldToast = document.querySelector(".toast");
  if (oldToast) oldToast.remove();
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3200);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
