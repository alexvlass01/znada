'use strict';

// BUG-048: the real suggestion and search IPCs must agree on the site's tag. A broad
// unfiltered response is not success: the network fixture only returns the requested tag.
const assert = require('assert/strict');
const path = require('path');
const { makeTempProfile, loadMain, unloadMain, writeJson } = require('./helpers/main-harness');

const tag = 'beatrice_(re:zero)';
const originalFetch = globalThis.fetch;

(async () => {
  for (const provider of ['gelbooru', 'danbooru']) {
    const profile = makeTempProfile('bug048-' + provider);
    writeJson(path.join(profile, 'config.json'), {
      autoSwitch: false, onlineSources: { lumina: false, internet: true,
        providers: { wallhaven: false, gelbooru: provider === 'gelbooru', danbooru: provider === 'danbooru' } },
    });
    const main = loadMain(profile);
    main.__test.setProviderCredentials('gelbooru', { userId: 'fixture', apiKey: 'fixture' });
    main.__test.loadConfig();
    const queries = [];
    globalThis.fetch = async (target) => {
      const url = new URL(target);
      let json;
      if (url.searchParams.get('page') === 'autocomplete2' || url.pathname === '/autocomplete.json') {
        assert.equal(url.searchParams.get('term') || url.searchParams.get('search[query]'), 'beatrice_(re:');
        json = [{ value: tag, post_count: 2186, category: 4 }];
      } else {
        const tags = url.searchParams.get('tags');
        queries.push(tags);
        const match = tags.split(' ').includes(tag);
        const posts = match ? [{
          id: 48, width: 1920, height: 1080, image_width: 1920, image_height: 1080,
          file_url: provider === 'gelbooru' ? 'https://img3.gelbooru.com/images/aa/bb/fixture.jpg' : 'https://cdn.donmai.us/original/aa/fixture.jpg',
          preview_url: 'https://img3.gelbooru.com/thumbnails/aa/bb/fixture.jpg',
          preview_file_url: 'https://cdn.donmai.us/preview/aa/fixture.jpg',
          file_ext: 'jpg', rating: provider === 'gelbooru' ? 'general' : 'g', tags: tag, tag_string: tag,
        }] : [];
        json = provider === 'gelbooru' ? { post: posts, '@attributes': { count: posts.length, offset: 0 } } : posts;
      }
      return { ok: true, status: 200, json: async () => json };
    };
    try {
      const suggestion = await main.invoke('internet-tag-suggest', { q: 'beatrice_(re:', limit: 10 });
      assert.equal(suggestion.items[0]?.name, tag, provider + ': IPC suggestion spelling');
      for (const sort of ['date_added', 'toplist', 'random']) {
        const result = await main.invoke('internet-search', {
          q: suggestion.items[0].name, page: 1, sort,
          purity: { sfw: true, sketchy: false, nsfw: false },
        });
        assert.equal(result.items.length, 1, provider + ': exact-tag result for ' + sort);
        assert.ok(queries.at(-1).split(' ').includes(tag));
        assert.ok(queries.at(-1).split(' ').includes(provider === 'gelbooru' ? 'rating:general' : 'rating:g'));
        if (provider === 'danbooru' && sort === 'toplist') assert.ok(queries.at(-1).includes('order:score'));
      }
      const wrong = await main.invoke('internet-search', { q: 'beatrice_(rezero)', page: 1 });
      assert.equal(wrong.items.length, 0, 'an unknown spelling is not silently replaced or broadened');
      console.log(provider + ': exact suggestion/search IPC chain passes');
    } finally {
      globalThis.fetch = originalFetch;
      unloadMain();
    }
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
