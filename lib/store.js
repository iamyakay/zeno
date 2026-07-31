const { app } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

function jsonFile(name) {
  const file = path.join(app.getPath("userData"), name);
  return {
    read(fallback) {
      try {
        const data = JSON.parse(fs.readFileSync(file, "utf8"));
        return Array.isArray(fallback) && !Array.isArray(data) ? fallback : data;
      } catch {
        return fallback;
      }
    },
    write(value) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(value));
    },
    remove() {
      try { fs.unlinkSync(file); } catch {}
    }
  };
}

const chats = jsonFile("zeno-chats.json");
const todos = jsonFile("zeno-todos.json");
const memory = jsonFile("zeno-memory.json");

function register(ipcMain) {
  ipcMain.handle("chats:list", () => {
    return chats.read([]).map((c) => ({ id: c.id, title: c.title, at: c.at, count: c.messages.length }));
  });

  ipcMain.handle("chats:save", (_event, session) => {
    if (!session?.id || !Array.isArray(session.messages) || session.messages.length === 0) return false;
    const all = chats.read([]);
    const index = all.findIndex((c) => c.id === session.id);
    if (index >= 0) all[index] = session;
    else all.push(session);
    while (all.length > 60) all.shift();
    chats.write(all);
    return true;
  });

  ipcMain.handle("chats:load", (_event, id) => chats.read([]).find((c) => c.id === id) || null);

  ipcMain.handle("chats:delete", (_event, id) => {
    chats.write(chats.read([]).filter((c) => c.id !== id));
    return true;
  });

  ipcMain.handle("todo:list", () => todos.read([]));

  ipcMain.handle("todo:add", (_event, text) => {
    const all = todos.read([]);
    all.push({ text: String(text).slice(0, 200), at: new Date().toISOString() });
    while (all.length > 50) all.shift();
    todos.write(all);
    return all;
  });

  ipcMain.handle("todo:done", (_event, match) => {
    const all = todos.read([]);
    const needle = String(match).toLowerCase();
    const index = all.findIndex((t) => t.text.toLowerCase().includes(needle));
    if (index === -1) return { removed: null, todos: all };
    const [removed] = all.splice(index, 1);
    todos.write(all);
    return { removed: removed.text, todos: all };
  });

  ipcMain.handle("todo:clear", () => {
    todos.write([]);
    return [];
  });

  ipcMain.handle("mem:list", () => memory.read([]));

  ipcMain.handle("mem:add", (_event, fact) => {
    const all = memory.read([]);
    all.push({ fact: String(fact).slice(0, 500), at: new Date().toISOString() });
    while (all.length > 100) all.shift();
    memory.write(all);
    return all;
  });

  ipcMain.handle("mem:clear", () => {
    memory.remove();
    return [];
  });
}

module.exports = { register };
