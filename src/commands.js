// Slash command definitions. Registered once with scripts/register-commands.mjs.
export function commandDefinitions(prefix = 'pb') {
  const user = {
    type: 6,
    name: 'user',
    description: 'Leave empty for yourself; choose a linked Discord user for others',
    required: false,
  };
  return [
    { name: `${prefix}-stats`, type: 1, description: "Check your or another linked player's level and XP", options: [user] },
    { name: `${prefix}-playtime`, type: 1, description: 'Check time played on Project Brainless', options: [user] },
    { name: `${prefix}-top`, type: 1, description: 'Top 10 Project Brainless players by XP' },
    {
      name: `${prefix}-link`,
      type: 1,
      description: 'Link your game account with a pblink code',
      options: [{ type: 3, name: 'code', description: "One-time code from the game's .pblink command", required: true }],
    },
    { name: `${prefix}-optout`, type: 1, description: 'Stop tracking and erase your linked game stats' },
  ];
}
