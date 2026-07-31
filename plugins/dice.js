module.exports = {
  name: "dice",
  description: "roll dice and flip coins: roll a d20, roll 3 dice, flip a coin",
  pattern: /^(?:roll|flip)\b/i,
  run(input) {
    const text = input.toLowerCase();
    if (/flip/.test(text)) {
      return Math.random() < 0.5 ? "heads" : "tails";
    }
    const dMatch = text.match(/d(\d+)/);
    const sides = dMatch ? Math.max(2, Math.min(1000, Number(dMatch[1]))) : 6;
    const countMatch = text.match(/(\d+)\s*(?:dice|times|d\d+)/);
    const count = Math.max(1, Math.min(20, countMatch ? Number(countMatch[1]) : 1));
    const rolls = Array.from({ length: count }, () => 1 + Math.floor(Math.random() * sides));
    if (count === 1) {
      return `rolled a d${sides}: ${rolls[0]}`;
    }
    const total = rolls.reduce((sum, r) => sum + r, 0);
    return `rolled ${count}x d${sides}: ${rolls.join(", ")} (total ${total})`;
  }
};
