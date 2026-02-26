// ABOUTME: Tests for topic extraction from VTT transcript text
// ABOUTME: Verifies keyword matching, confidence scoring, and output format

import { describe, it, expect } from 'vitest';
import { extractTopics, topicsToLabels, topicsToWeightedFeatures } from './topic-extractor.mjs';

describe('extractTopics', () => {
  // ──────────────────────────────────────────────
  // Edge cases: empty / missing input
  // ──────────────────────────────────────────────
  describe('empty input', () => {
    it('should return empty result for null input', () => {
      const result = extractTopics(null);
      expect(result.topics).toEqual([]);
      expect(result.primary_topic).toBeNull();
      expect(result.has_speech).toBe(false);
      expect(result.language_hint).toBe('unknown');
      expect(result.word_count).toBe(0);
    });

    it('should return empty result for undefined input', () => {
      const result = extractTopics(undefined);
      expect(result.topics).toEqual([]);
      expect(result.primary_topic).toBeNull();
      expect(result.word_count).toBe(0);
    });

    it('should return empty result for empty string', () => {
      const result = extractTopics('');
      expect(result.topics).toEqual([]);
      expect(result.primary_topic).toBeNull();
      expect(result.word_count).toBe(0);
    });

    it('should return empty result for whitespace-only string', () => {
      const result = extractTopics('   \n\t  ');
      expect(result.topics).toEqual([]);
      expect(result.primary_topic).toBeNull();
      expect(result.word_count).toBe(0);
    });
  });

  // ──────────────────────────────────────────────
  // Output structure validation
  // ──────────────────────────────────────────────
  describe('output structure', () => {
    it('should include all required fields', () => {
      const result = extractTopics('this is a song about singing and music');
      expect(result).toHaveProperty('topics');
      expect(result).toHaveProperty('primary_topic');
      expect(result).toHaveProperty('has_speech');
      expect(result).toHaveProperty('language_hint');
      expect(result).toHaveProperty('word_count');
    });

    it('should have correct topic entry structure', () => {
      const result = extractTopics('this is a song about singing and music');
      expect(result.topics.length).toBeGreaterThan(0);
      const topic = result.topics[0];
      expect(topic).toHaveProperty('category');
      expect(topic).toHaveProperty('confidence');
      expect(topic).toHaveProperty('keywords_matched');
      expect(typeof topic.category).toBe('string');
      expect(typeof topic.confidence).toBe('number');
      expect(Array.isArray(topic.keywords_matched)).toBe(true);
    });

    it('should sort topics by confidence descending', () => {
      const result = extractTopics(
        'this is a song about singing and music with lyrics and melody. also funny joke lol'
      );
      for (let i = 1; i < result.topics.length; i++) {
        expect(result.topics[i].confidence).toBeLessThanOrEqual(result.topics[i - 1].confidence);
      }
    });

    it('should set primary_topic to the highest confidence category', () => {
      const result = extractTopics('this is a song about singing and music with lyrics');
      expect(result.primary_topic).toBe(result.topics[0].category);
    });

    it('should round confidence to 2 decimal places', () => {
      const result = extractTopics('this is a song');
      for (const topic of result.topics) {
        const decimalPlaces = (topic.confidence.toString().split('.')[1] || '').length;
        expect(decimalPlaces).toBeLessThanOrEqual(2);
      }
    });

    it('should cap confidence at 1.0', () => {
      // Flood the text with music keywords to exceed threshold
      const text = 'song singing music lyrics melody chorus singer musician band album concert karaoke';
      const result = extractTopics(text);
      for (const topic of result.topics) {
        expect(topic.confidence).toBeLessThanOrEqual(1.0);
      }
    });

    it('should count words correctly', () => {
      const result = extractTopics('hello world this is a test');
      expect(result.word_count).toBe(6);
    });
  });

  // ──────────────────────────────────────────────
  // Music detection
  // ──────────────────────────────────────────────
  describe('music category', () => {
    it('should detect music from song/singing keywords', () => {
      const result = extractTopics('I love this song so much, the singing is beautiful');
      const music = result.topics.find(t => t.category === 'music');
      expect(music).toBeDefined();
      expect(music.confidence).toBeGreaterThanOrEqual(0.5);
      expect(music.keywords_matched).toContain('song');
      expect(music.keywords_matched).toContain('singing');
    });

    it('should detect music from instrument keywords', () => {
      const result = extractTopics('playing guitar and piano with some drums in the background');
      const music = result.topics.find(t => t.category === 'music');
      expect(music).toBeDefined();
      expect(music.keywords_matched).toContain('guitar');
      expect(music.keywords_matched).toContain('piano');
    });

    it('should detect music from genre/style keywords', () => {
      const result = extractTopics('this hip hop beat is fire, the freestyle rapping is incredible');
      const music = result.topics.find(t => t.category === 'music');
      expect(music).toBeDefined();
      expect(music.keywords_matched).toContain('rapping');
    });
  });

  // ──────────────────────────────────────────────
  // Comedy detection
  // ──────────────────────────────────────────────
  describe('comedy category', () => {
    it('should detect comedy from joke/funny keywords', () => {
      const result = extractTopics('this joke is so funny I cannot stop laughing');
      const comedy = result.topics.find(t => t.category === 'comedy');
      expect(comedy).toBeDefined();
      expect(comedy.confidence).toBeGreaterThanOrEqual(0.5);
      expect(comedy.keywords_matched).toContain('joke');
      expect(comedy.keywords_matched).toContain('funny');
    });

    it('should detect comedy from prank/skit keywords', () => {
      const result = extractTopics('we pranked our friend with this hilarious skit');
      const comedy = result.topics.find(t => t.category === 'comedy');
      expect(comedy).toBeDefined();
      expect(comedy.keywords_matched).toContain('pranked');
    });
  });

  // ──────────────────────────────────────────────
  // Dance detection
  // ──────────────────────────────────────────────
  describe('dance category', () => {
    it('should detect dance from choreography keywords', () => {
      const result = extractTopics('learning this new dance choreography took me a week');
      const dance = result.topics.find(t => t.category === 'dance');
      expect(dance).toBeDefined();
      expect(dance.keywords_matched).toContain('dance');
      expect(dance.keywords_matched).toContain('choreography');
    });

    it('should detect dance styles', () => {
      const result = extractTopics('my ballet class was so fun today, we learned the tango');
      const dance = result.topics.find(t => t.category === 'dance');
      expect(dance).toBeDefined();
      expect(dance.keywords_matched).toContain('ballet');
      expect(dance.keywords_matched).toContain('tango');
    });
  });

  // ──────────────────────────────────────────────
  // Sports detection
  // ──────────────────────────────────────────────
  describe('sports category', () => {
    it('should detect sports from general terms', () => {
      const result = extractTopics('the team scored an amazing goal in the championship');
      const sports = result.topics.find(t => t.category === 'sports');
      expect(sports).toBeDefined();
      expect(sports.keywords_matched).toContain('team');
      expect(sports.keywords_matched).toContain('goal');
      expect(sports.keywords_matched).toContain('championship');
    });

    it('should detect specific sports', () => {
      const result = extractTopics('watching the basketball game, what a slam dunk');
      const sports = result.topics.find(t => t.category === 'sports');
      expect(sports).toBeDefined();
      expect(sports.keywords_matched).toContain('basketball');
      expect(sports.keywords_matched).toContain('slam dunk');
    });
  });

  // ──────────────────────────────────────────────
  // Food detection
  // ──────────────────────────────────────────────
  describe('food category', () => {
    it('should detect food from cooking keywords', () => {
      const result = extractTopics('today we are cooking a delicious recipe with fresh ingredients');
      const food = result.topics.find(t => t.category === 'food');
      expect(food).toBeDefined();
      expect(food.confidence).toBeGreaterThanOrEqual(0.5);
      expect(food.keywords_matched).toContain('cooking');
      expect(food.keywords_matched).toContain('recipe');
      expect(food.keywords_matched).toContain('ingredients');
    });

    it('should detect food from foodie culture keywords', () => {
      const result = extractTopics('mukbang time! this is the best foodie experience');
      const food = result.topics.find(t => t.category === 'food');
      expect(food).toBeDefined();
      expect(food.keywords_matched).toContain('mukbang');
      expect(food.keywords_matched).toContain('foodie');
    });
  });

  // ──────────────────────────────────────────────
  // Animals detection
  // ──────────────────────────────────────────────
  describe('animals category', () => {
    it('should detect animals from pet keywords', () => {
      const result = extractTopics('my puppy is the cutest doggo ever, such a good boy');
      const animals = result.topics.find(t => t.category === 'animals');
      expect(animals).toBeDefined();
      expect(animals.keywords_matched).toContain('puppy');
      expect(animals.keywords_matched).toContain('doggo');
    });

    it('should detect animals from wildlife keywords', () => {
      const result = extractTopics('check out this amazing wildlife at the zoo');
      const animals = result.topics.find(t => t.category === 'animals');
      expect(animals).toBeDefined();
      expect(animals.keywords_matched).toContain('wildlife');
      expect(animals.keywords_matched).toContain('zoo');
    });
  });

  // ──────────────────────────────────────────────
  // Fashion/beauty detection
  // ──────────────────────────────────────────────
  describe('fashion category', () => {
    it('should detect fashion from outfit/style keywords', () => {
      const result = extractTopics('check out my outfit of the day, this haul was amazing');
      const fashion = result.topics.find(t => t.category === 'fashion');
      expect(fashion).toBeDefined();
      expect(fashion.keywords_matched).toContain('outfit');
    });

    it('should detect beauty from makeup/skincare keywords', () => {
      const result = extractTopics('grwm skincare routine with foundation and lipstick');
      const fashion = result.topics.find(t => t.category === 'fashion');
      expect(fashion).toBeDefined();
      expect(fashion.keywords_matched).toContain('grwm');
      expect(fashion.keywords_matched).toContain('skincare');
    });
  });

  // ──────────────────────────────────────────────
  // Art/creative detection
  // ──────────────────────────────────────────────
  describe('art category', () => {
    it('should detect art from painting/drawing keywords', () => {
      const result = extractTopics('I spent all day painting on this canvas with watercolor');
      const art = result.topics.find(t => t.category === 'art');
      expect(art).toBeDefined();
      expect(art.keywords_matched).toContain('painting');
      expect(art.keywords_matched).toContain('canvas');
      expect(art.keywords_matched).toContain('watercolor');
    });

    it('should detect art from craft keywords', () => {
      const result = extractTopics('making this diy handmade crochet project');
      const art = result.topics.find(t => t.category === 'art');
      expect(art).toBeDefined();
      expect(art.keywords_matched).toContain('diy');
      expect(art.keywords_matched).toContain('crochet');
    });
  });

  // ──────────────────────────────────────────────
  // Education detection
  // ──────────────────────────────────────────────
  describe('education category', () => {
    it('should detect education from tutorial keywords', () => {
      const result = extractTopics('this tutorial will teach you step by step how to do it');
      const edu = result.topics.find(t => t.category === 'education');
      expect(edu).toBeDefined();
      expect(edu.keywords_matched).toContain('tutorial');
    });

    it('should detect education from learning/science keywords', () => {
      const result = extractTopics('did you know these amazing science facts? let me explain');
      const edu = result.topics.find(t => t.category === 'education');
      expect(edu).toBeDefined();
      expect(edu.keywords_matched).toContain('science');
    });
  });

  // ──────────────────────────────────────────────
  // Gaming detection
  // ──────────────────────────────────────────────
  describe('gaming category', () => {
    it('should detect gaming from gameplay keywords', () => {
      const result = extractTopics('check out this epic gameplay, the boss fight was insane');
      const gaming = result.topics.find(t => t.category === 'gaming');
      expect(gaming).toBeDefined();
      expect(gaming.keywords_matched).toContain('gameplay');
      expect(gaming.keywords_matched).toContain('boss fight');
    });

    it('should detect gaming from specific game names', () => {
      const result = extractTopics('playing fortnite and minecraft with my friends on xbox');
      const gaming = result.topics.find(t => t.category === 'gaming');
      expect(gaming).toBeDefined();
      expect(gaming.confidence).toBeGreaterThanOrEqual(0.5);
      expect(gaming.keywords_matched).toContain('fortnite');
      expect(gaming.keywords_matched).toContain('minecraft');
      expect(gaming.keywords_matched).toContain('xbox');
    });
  });

  // ──────────────────────────────────────────────
  // Nature/outdoors detection
  // ──────────────────────────────────────────────
  describe('nature category', () => {
    it('should detect nature from outdoor keywords', () => {
      const result = extractTopics('hiking through the forest to see the waterfall and the mountain');
      const nature = result.topics.find(t => t.category === 'nature');
      expect(nature).toBeDefined();
      expect(nature.keywords_matched).toContain('hiking');
      expect(nature.keywords_matched).toContain('forest');
      expect(nature.keywords_matched).toContain('waterfall');
    });

    it('should detect nature from gardening keywords', () => {
      const result = extractTopics('gardening is so relaxing, planting flowers and watching the sunset');
      const nature = result.topics.find(t => t.category === 'nature');
      expect(nature).toBeDefined();
      expect(nature.keywords_matched).toContain('gardening');
    });
  });

  // ──────────────────────────────────────────────
  // Technology detection
  // ──────────────────────────────────────────────
  describe('technology category', () => {
    it('should detect technology from gadget/review keywords', () => {
      const result = extractTopics('unboxing the new iphone, this smartphone is amazing tech');
      const tech = result.topics.find(t => t.category === 'technology');
      expect(tech).toBeDefined();
      expect(tech.keywords_matched).toContain('unboxing');
      expect(tech.keywords_matched).toContain('iphone');
    });

    it('should detect technology from coding/programming keywords', () => {
      const result = extractTopics('coding a new software project, programming in python with machine learning');
      const tech = result.topics.find(t => t.category === 'technology');
      expect(tech).toBeDefined();
      expect(tech.keywords_matched).toContain('coding');
      expect(tech.keywords_matched).toContain('software');
      expect(tech.keywords_matched).toContain('programming');
    });
  });

  // ──────────────────────────────────────────────
  // Travel detection
  // ──────────────────────────────────────────────
  describe('travel category', () => {
    it('should detect travel from vacation keywords', () => {
      const result = extractTopics('traveling to this amazing destination for our vacation, sightseeing all day');
      const travel = result.topics.find(t => t.category === 'travel');
      expect(travel).toBeDefined();
      expect(travel.keywords_matched).toContain('traveling');
      expect(travel.keywords_matched).toContain('destination');
      expect(travel.keywords_matched).toContain('sightseeing');
    });

    it('should detect travel from backpacking keywords', () => {
      const result = extractTopics('backpacking through europe, staying in a hostel, road trip vibes');
      const travel = result.topics.find(t => t.category === 'travel');
      expect(travel).toBeDefined();
      expect(travel.keywords_matched).toContain('backpacking');
      expect(travel.keywords_matched).toContain('hostel');
      expect(travel.keywords_matched).toContain('road trip');
    });
  });

  // ──────────────────────────────────────────────
  // Fitness/health detection
  // ──────────────────────────────────────────────
  describe('fitness category', () => {
    it('should detect fitness from workout keywords', () => {
      const result = extractTopics('today we are doing a workout at the gym with some cardio and squats');
      const fitness = result.topics.find(t => t.category === 'fitness');
      expect(fitness).toBeDefined();
      expect(fitness.keywords_matched).toContain('workout');
      expect(fitness.keywords_matched).toContain('gym');
      expect(fitness.keywords_matched).toContain('cardio');
    });

    it('should detect fitness from yoga/wellness keywords', () => {
      const result = extractTopics('yoga and meditation for wellness and stretching');
      const fitness = result.topics.find(t => t.category === 'fitness');
      expect(fitness).toBeDefined();
      expect(fitness.keywords_matched).toContain('yoga');
      expect(fitness.keywords_matched).toContain('meditation');
    });
  });

  // ──────────────────────────────────────────────
  // News/politics detection
  // ──────────────────────────────────────────────
  describe('news category', () => {
    it('should detect news from politics keywords', () => {
      const result = extractTopics('breaking news about the election, the president and congress');
      const news = result.topics.find(t => t.category === 'news');
      expect(news).toBeDefined();
      expect(news.keywords_matched).toContain('breaking news');
      expect(news.keywords_matched).toContain('election');
      expect(news.keywords_matched).toContain('president');
    });

    it('should detect news from journalism keywords', () => {
      const result = extractTopics('this journalist is reporting on the protest and the controversy');
      const news = result.topics.find(t => t.category === 'news');
      expect(news).toBeDefined();
      expect(news.keywords_matched).toContain('journalist');
    });
  });

  // ──────────────────────────────────────────────
  // Multi-topic detection
  // ──────────────────────────────────────────────
  describe('multi-topic content', () => {
    it('should detect multiple topics in mixed content', () => {
      const text = 'this funny song has great choreography, the dancing and singing are hilarious';
      const result = extractTopics(text);
      const categories = result.topics.map(t => t.category);
      expect(categories).toContain('music');
      expect(categories).toContain('comedy');
      expect(categories).toContain('dance');
    });

    it('should correctly rank primary topic for music-heavy content', () => {
      const text = 'singing a beautiful song with lyrics and melody on the guitar, also kind of funny';
      const result = extractTopics(text);
      expect(result.primary_topic).toBe('music');
    });
  });

  // ──────────────────────────────────────────────
  // Speech detection
  // ──────────────────────────────────────────────
  describe('speech detection', () => {
    it('should detect speech in natural English text', () => {
      const result = extractTopics('this is a really fun song that I want to share with you and your friends');
      expect(result.has_speech).toBe(true);
    });

    it('should not detect speech in very short text', () => {
      const result = extractTopics('ok wow');
      expect(result.has_speech).toBe(false);
    });

    it('should not detect speech in keyword-only text with no function words', () => {
      const result = extractTopics('basketball soccer tennis volleyball');
      expect(result.has_speech).toBe(false);
    });
  });

  // ──────────────────────────────────────────────
  // Language hint detection
  // ──────────────────────────────────────────────
  describe('language hint', () => {
    it('should detect English', () => {
      const result = extractTopics('the song is really good and this is the best music I have heard');
      expect(result.language_hint).toBe('en');
    });

    it('should detect Spanish', () => {
      const result = extractTopics('esta cancion es la mejor que he escuchado en el mundo, con las mejores letras del album');
      expect(result.language_hint).toBe('es');
    });

    it('should return unknown for very short or ambiguous text', () => {
      const result = extractTopics('hmm ok');
      expect(result.language_hint).toBe('unknown');
    });
  });

  // ──────────────────────────────────────────────
  // No matches
  // ──────────────────────────────────────────────
  describe('no matches', () => {
    it('should return no topics for completely unrelated text', () => {
      const result = extractTopics('lorem ipsum dolor sit amet consectetur adipiscing elit');
      expect(result.topics.length).toBe(0);
      expect(result.primary_topic).toBeNull();
    });
  });

  // ──────────────────────────────────────────────
  // Case insensitivity
  // ──────────────────────────────────────────────
  describe('case insensitivity', () => {
    it('should match keywords regardless of case', () => {
      const result = extractTopics('SINGING A SONG about MUSIC and LYRICS');
      const music = result.topics.find(t => t.category === 'music');
      expect(music).toBeDefined();
      expect(music.confidence).toBeGreaterThanOrEqual(0.5);
    });

    it('should return lowercased keywords_matched', () => {
      const result = extractTopics('SINGING a SONG');
      const music = result.topics.find(t => t.category === 'music');
      expect(music).toBeDefined();
      for (const kw of music.keywords_matched) {
        expect(kw).toBe(kw.toLowerCase());
      }
    });
  });
});

// ──────────────────────────────────────────────
// topicsToLabels
// ──────────────────────────────────────────────
describe('topicsToLabels', () => {
  it('should return labels for topics above minConfidence', () => {
    const result = extractTopics('this is a song about singing and music with lyrics and melody');
    const labels = topicsToLabels(result, 0.3);
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) {
      expect(label).toMatch(/^topic:/);
    }
  });

  it('should filter out low confidence topics', () => {
    const result = {
      topics: [
        { category: 'music', confidence: 0.8, keywords_matched: ['song'] },
        { category: 'comedy', confidence: 0.2, keywords_matched: ['funny'] },
      ],
    };
    const labels = topicsToLabels(result, 0.3);
    expect(labels).toEqual(['topic:music']);
  });

  it('should return empty array for null input', () => {
    expect(topicsToLabels(null)).toEqual([]);
    expect(topicsToLabels(undefined)).toEqual([]);
  });

  it('should use default minConfidence of 0.3', () => {
    const result = {
      topics: [
        { category: 'music', confidence: 0.3, keywords_matched: ['song'] },
        { category: 'comedy', confidence: 0.29, keywords_matched: ['funny'] },
      ],
    };
    const labels = topicsToLabels(result);
    expect(labels).toEqual(['topic:music']);
  });
});

// ──────────────────────────────────────────────
// topicsToWeightedFeatures
// ──────────────────────────────────────────────
describe('topicsToWeightedFeatures', () => {
  it('should return weighted feature map', () => {
    const result = {
      topics: [
        { category: 'music', confidence: 0.8, keywords_matched: ['song'] },
        { category: 'comedy', confidence: 0.6, keywords_matched: ['funny'] },
      ],
    };
    const features = topicsToWeightedFeatures(result);
    expect(features).toEqual({
      'topic:music': 0.8,
      'topic:comedy': 0.6,
    });
  });

  it('should filter out topics below minConfidence', () => {
    const result = {
      topics: [
        { category: 'music', confidence: 0.8, keywords_matched: ['song'] },
        { category: 'comedy', confidence: 0.1, keywords_matched: ['funny'] },
      ],
    };
    const features = topicsToWeightedFeatures(result, 0.15);
    expect(features).toEqual({ 'topic:music': 0.8 });
  });

  it('should return empty object for null input', () => {
    expect(topicsToWeightedFeatures(null)).toEqual({});
    expect(topicsToWeightedFeatures(undefined)).toEqual({});
  });
});
