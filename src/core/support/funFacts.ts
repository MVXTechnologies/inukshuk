/**
 * The mascot bubble's fun facts (#476, round 4), EN + FR, each ≤ 110
 * characters. Playful, never pushy; they rotate and never repeat back to back.
 *
 * Pure: no React Native / Expo imports.
 */

export interface FunFact {
  en: string;
  fr: string;
}

export const FUN_FACT_MAX_CHARS = 110;

export const FUN_FACTS: readonly FunFact[] = [
  // Owner's own.
  {
    en: 'Did you know there’s a dinosaur called the Donationausaurus? Very generous indeed.',
    fr: 'Saviez-vous qu’il existe un dinosaure appelé Donationausaurus? Très généreux, en effet.',
  },
  // Owner's own, kept word for word. OWNER TO CONFIRM before release: it is
  // only true if (active users × $2.99) ≥ the private yearly goal. The app
  // cannot check that (it knows no user count and no goal amount), so this
  // line is unverified — reword or drop it if the numbers don't hold.
  {
    en: 'If every user donated a coffee, the app would be paid for the whole year — today!',
    fr: 'Si chaque personne offrait un café, l’appli serait payée pour toute l’année — aujourd’hui!',
  },
  {
    en: 'An inukshuk is stones helping each other stand. Tips work the same way.',
    fr: 'Un inukshuk, ce sont des pierres qui s’aident à tenir debout. Les pourboires aussi.',
  },
  {
    en: 'Map servers run on coffee too. Mostly metaphorically.',
    fr: 'Les serveurs de cartes carburent aussi au café. Surtout au sens figuré.',
  },
  {
    en: 'Every tip adds a stone to the cairn. Rock on!',
    fr: 'Chaque pourboire ajoute une pierre au cairn. Solide comme le roc!',
  },
  {
    en: 'Contour lines are free. Keeping them online costs about one latte.',
    fr: 'Les courbes de niveau sont gratuites. Les garder en ligne coûte environ un latte.',
  },
  {
    en: 'This mug has never hiked a single trail, but it carries the whole app. Help it out?',
    fr: 'Cette tasse n’a jamais fait de sentier, mais elle porte toute l’appli. Un coup de main?',
  },
  {
    en: 'No ads, no tracking — just a small mug with big summit dreams.',
    fr: 'Pas de pub, pas de pistage — juste une petite tasse qui rêve de sommets.',
  },
];

/**
 * The next fact to show: random, but never the one just shown. `random` is
 * injectable for tests (defaults to Math.random).
 */
export function nextFactIndex(last: number | null, random: () => number = Math.random): number {
  const n = FUN_FACTS.length;
  if (n <= 1) return 0;
  if (last === null || last < 0 || last >= n) return Math.floor(random() * n) % n;
  // Pick among the other n − 1 facts, then skip over `last`.
  const pick = Math.floor(random() * (n - 1)) % (n - 1);
  return pick >= last ? pick + 1 : pick;
}

/** The fact in the reader's language (French when the device locale is French). */
export function factText(index: number, locale: string | null | undefined): string {
  const fact = FUN_FACTS[index] ?? FUN_FACTS[0];
  if (fact === undefined) return '';
  return typeof locale === 'string' && /^fr\b/i.test(locale) ? fact.fr : fact.en;
}
