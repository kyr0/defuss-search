/** Reproduces vectorsearch 0.2.1's published "Bücher" dense-winner case. */
export const documents = [
  ['library', 'Die neue Bibliothek in der Innenstadt hat bis 22 Uhr geöffnet.'],
  ['rent', 'Договор аренды заканчивается в марте.'],
  ['tax', 'The tax return is due at the end of July.'],
  ['hike', 'Для похода в горы взять крепкие ботинки и дождевик.'],
].map(([id, text]) => ({ id, fields: { text } }));
export const query = 'Bücher';
