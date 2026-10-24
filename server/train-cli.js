// Usage: npm run train -- [episodes] [scenario]
import { trainSelfPlay } from '../core/simulation.js';
import { loadPolicies, savePolicy } from './policies.js';

const episodes = Number(process.argv[2] ?? 3000);
const scenario = process.argv[3] ?? 'small';
const resume = process.argv.includes('--resume');

const t0 = Date.now();
const history = [];
const { policies } = trainSelfPlay({
  scenario,
  episodes,
  policies: resume ? loadPolicies() : {},
  onProgress: (p) => {
    history.push(p);
    if (p.episode % Math.max(1, Math.floor(episodes / 10)) === 0) {
      const window = history.slice(-100);
      const redWins = window.filter((x) => x.outcome === 'red-objective').length;
      const blueWins = window.filter((x) => x.outcome === 'blue-contained').length;
      console.log(`ep ${p.episode}/${episodes}  eps=${p.epsilon}  last100: red ${redWins}% blue ${blueWins}%`);
    }
  },
});
savePolicy('red', policies.red);
savePolicy('blue', policies.blue);
console.log(`Saved policies/red.json + policies/blue.json in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
