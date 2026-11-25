// Book cover. Uses the book's own image when it has a safe (https) one; otherwise draws a cover
// from the title and author. The cover is decorative: the same text is always present beside it.
const TONE_BY_CATEGORY = {
  fiction: 'navy',
  'science-fiction': 'teal',
  mystery: 'wine',
  science: 'forest',
  history: 'umber',
  philosophy: 'plum',
};
const TONES = ['navy', 'teal', 'wine', 'forest', 'umber', 'plum'];

function toneFor(slug = '') {
  if (TONE_BY_CATEGORY[slug]) return TONE_BY_CATEGORY[slug];
  let hash = 0;
  for (const ch of slug) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return TONES[hash % TONES.length];
}

const isSafeImageUrl = (url) => typeof url === 'string' && /^https:\/\//i.test(url);

export default function BookCover({ book }) {
  if (isSafeImageUrl(book.coverUrl)) {
    return (
      <div className="bk-cover bk-cover--image">
        <img src={book.coverUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />
      </div>
    );
  }
  return (
    <div className={`bk-cover bk-cover--${toneFor(book.category?.slug)}`} aria-hidden="true">
      <span className="bk-cover__title">{book.title}</span>
      <span className="bk-cover__rule" />
      <span className="bk-cover__author">{book.author?.name}</span>
    </div>
  );
}
