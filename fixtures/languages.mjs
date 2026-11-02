/**
 * Authored retrieval smoke cases; these verify analyzer integration, not model quality.
 * VERIFIED: `analysis` names how the lexicalsearch 0.3.0 entry analyzes text, as its README labels it.
 */
export const languageCases = [
  ['en', 'eng_Latn', 'English', 'We read books in the libraries.', 'library', 'Snowball'],
  ['de', 'deu_Latn', 'German', 'Wir lesen Bücher in den Bibliotheken.', 'Bibliothek', 'Snowball'],
  [
    'fr',
    'fra_Latn',
    'French',
    'Nous lisons des livres dans les bibliothèques.',
    'bibliothèque',
    'Snowball',
  ],
  ['es', 'spa_Latn', 'Spanish', 'Leemos libros en las bibliotecas.', 'biblioteca', 'Snowball'],
  [
    'pt',
    'por_Latn',
    'Portuguese',
    'Estávamos lendo livros nas bibliotecas.',
    'biblioteca',
    'Snowball',
  ],
  ['it', 'ita_Latn', 'Italian', 'Leggevamo libri nelle biblioteche.', 'biblioteca', 'Snowball'],
  ['nl', 'nld_Latn', 'Dutch', 'We lazen boeken in de bibliotheken.', 'bibliotheek', 'Snowball'],
  ['pl', 'pol_Latn', 'Polish', 'Czytaliśmy książki w bibliotekach.', 'biblioteka', 'Snowball'],
  ['ru', 'rus_Cyrl', 'Russian', 'Мы читали книги в библиотеке.', 'книга', 'Snowball'],
  ['tr', 'tur_Latn', 'Turkish', 'Kitapları kütüphanelerde okuduk.', 'kitap', 'Snowball'],
  ['ar', 'arb_Arab', 'Arabic', 'قرأنا الكتب في المكتبات.', 'المكتبة', 'Snowball'],
  ['hi', 'hin_Deva', 'Hindi', 'हमने पुस्तकालयों में किताबें पढ़ीं।', 'किताब', 'Snowball'],
  ['bn', 'ben_Beng', 'Bangla', 'আমরা গ্রন্থাগারে বই পড়েছিলাম।', 'গ্রন্থাগার', 'trigrams'],
  ['ur', 'urd_Arab', 'Urdu', 'ہم نے کتب خانوں میں کتابیں پڑھیں۔', 'کتاب', 'trigrams'],
  ['id', 'ind_Latn', 'Indonesian', 'Kami membaca buku di perpustakaan.', 'baca', 'Snowball'],
  ['vi', 'vie_Latn', 'Vietnamese', 'Chúng tôi đọc sách ở thư viện.', 'thư viện', 'tone folding'],
  ['th', 'tha_Thai', 'Thai', 'เราอ่านหนังสือในห้องสมุด', 'ห้องสมุด', 'segmenter'],
  ['zh', 'zho_Hans', 'Chinese', '我们在图书馆里读书。', '图书馆', 'segmenter'],
  ['ja', 'jpn_Jpan', 'Japanese', '東京の図書館で本を読んだ。', '図書館はどこ', 'segmenter'],
  ['ko', 'kor_Hang', 'Korean', '우리는 도서관에서 책을 읽었다.', '도서관', 'bigrams'],
].map(([entry, code, name, text, query, analysis]) => ({
  entry,
  code,
  name,
  text,
  query,
  analysis,
}));
export const targetLanguages = new Set([
  'deu_Latn',
  'rus_Cyrl',
  'eng_Latn',
  'fra_Latn',
  'ind_Latn',
  'nld_Latn',
  'ita_Latn',
  'por_Latn',
  'spa_Latn',
]);
