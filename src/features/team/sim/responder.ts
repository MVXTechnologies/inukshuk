/**
 * The simulated teammates' replies (demo builds only): a small rule-based
 * responder, French and English mixed like a Québec crew. No network, no
 * model: keywords, a few canned lines per mood, and a seeded pick. Pure.
 */

export type Rng = () => number;

const pick = <T>(rnd: Rng, xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;

const RULES: { test: RegExp; replies: readonly string[] }[] = [
  {
    test: /\b(bonjour|salut|allo|allô|hello|hi|hey|bon matin)\b/i,
    replies: ['Salut!', 'Allô la gang 👋', 'Hey! Bien arrivé', 'Bonjour! Ready when you are'],
  },
  {
    test: /\b(merci|thanks|thank you|thx)\b/i,
    replies: ['De rien!', 'Pas de problème', 'Anytime', 'Avec plaisir'],
  },
  {
    test: /\b(où|ou es|where|position|t'es où|tes ou)\b/i,
    replies: [
      'Je suis sur le sentier, pas loin du belvédère',
      'Almost at the junction, 5 min',
      'Je monte encore, environ 400 m du sommet',
      'Check the map, I’m sharing my position',
    ],
  },
  {
    test: /\b(pause|lunch|dîner|diner|manger|eat|break)\b/i,
    replies: [
      'Bonne idée, j’ai faim',
      'Pause au sommet?',
      'OK pour 12 h 30',
      'Yes, let’s eat at the top',
    ],
  },
  {
    test: /\b(météo|meteo|pluie|rain|weather|orage|storm|vent|wind)\b/i,
    replies: [
      'Ça se couvre à l’ouest, on garde un œil',
      'Pas de pluie ici pour l’instant',
      'Wind’s picking up on the ridge',
    ],
  },
  {
    test: /\b(retour|redescend|go back|head back|on rentre|départ|depart|leave)\b/i,
    replies: [
      'OK, on redescend vers 14 h',
      'Sounds good, je vous suis',
      'Je finis ma section et j’arrive',
    ],
  },
  {
    test: /\?\s*$/,
    replies: [
      'Bonne question… je regarde',
      'Je pense que oui',
      'Not sure, je vérifie',
      'Oui, ça marche',
    ],
  },
];

const GENERIC = ['👍', 'OK!', 'Parfait', 'Noted', 'D’accord', 'Bien reçu', 'Cool'];

/**
 * A reply to `text`, or null when this teammate stays quiet. A mention always
 * gets an answer; anything else does when a rule matches, or sometimes.
 */
export function replyTo(text: string, mentioned: boolean, rnd: Rng): string | null {
  for (const r of RULES) if (r.test.test(text)) return pick(rnd, r.replies);
  if (mentioned) return pick(rnd, ['Oui?', 'Je suis là', 'On it', 'Yes?', ...GENERIC]);
  return rnd() < 0.35 ? pick(rnd, GENERIC) : null;
}

export const ACK_TASK = [
  'OK, j’y vais',
  'On it!',
  'Parfait, je m’en occupe',
  'Reçu, j’arrive dans 10 min',
];

export const DONE_TASK = ['Fait ✔', 'Fait ✔ — c’est réglé', 'Done ✔', 'Fait ✔, photo à l’appui'];

export const PIN_LINES = [
  'Arbre tombé ici, passage difficile',
  'Boue profonde, contourner par la gauche',
  'Belle vue ici, ça vaut le détour',
  'Watch out: slippery rocks on this section',
  'Source d’eau ici, l’eau coule bien',
  'Balisage manquant à cette intersection',
];

export const PHOTO_LINES = [
  'Superbe photo!',
  'Wow, la lumière 😍',
  'C’est où exactement?',
  'Nice one — on y retourne cet automne',
  'Belle vue sur le fleuve',
];

export const PIN_REPLIES = [
  'Vu, merci pour l’info',
  'OK, je passe par là tantôt',
  'Good catch!',
  'Je confirme, c’est pareil de mon côté',
];

export const WAYPOINT_NAMES = ['Source', 'Belvédère', 'Abri', 'Jonction', 'Point d’eau'];

export const CHATTER = [
  'Je suis rendu au premier belvédère',
  'Quelqu’un a vu les balises jaunes?',
  'Petite pause eau ici',
  'Trail is in great shape today',
  'On se rejoint au sommet?',
  'Il fait frais en haut, apportez une couche',
];

export { pick };
