/**
 * Example requests for each optional prompt rule (rule-cases.ts OPTIONAL_RULES), for picking a request's rules
 * by embedding similarity, which doesn't depend on the chat model: a request would get a rule when it sits close
 * to that rule's examples and not to its `notFor` look-alikes. Being tried offline first; nothing in the app
 * reads these yet.
 *
 * Written apart from RULE_CASES (what the keywords are checked on), and tested not to repeat or nearly repeat
 * them (tests/capability-cards.test.ts), so a retrieval test isn't scored on its own examples. Most leave out
 * the rule's keywords on purpose: what the keywords already catch, an embedding has to catch too, and what they
 * miss ("make the screen sparkle", "hum me a lullaby") is what it's for. The look-alikes share a rule's words
 * or subject but not its need (a game of fetch, the key of a song, a story about a button).
 */

import type { RuleName } from './rule-cases.ts';

export interface CapabilityCard {
  name: RuleName;
  /** Requests the rule is for */
  examples: string[];
  /** Requests that look like them but don't need the rule */
  notFor: string[];
}

export const CAPABILITY_CARDS: ReadonlyArray<CapabilityCard> = [
  {
    // Anything to look at goes in the card
    name: 'card',
    examples: [
      'Put a big welcome message in the middle of the page',
      'Lay out my weekly chores as a grid',
      'I want to see a little green frog sitting on a lily pad',
      'Make a pretty page that lists my three favorite books',
      'Give me a sign that says closed for lunch in red letters',
      'Mock up a profile page for a cat named Biscuit',
      'Put up a scoreboard for tonight’s trivia night',
      'Build a business card for a plumber called Joe',
      'Line the planets up by size',
      'Can I see the flag of Japan?',
      'Set out a chessboard in front of me',
      'Make a birthday banner for my sister Ella',
      'Present today’s cafe specials nicely',
      'Make the screen sparkle',
    ],
    notFor: ['Say good night to me', 'What is the square root of 144?', 'Hum me a lullaby', 'Whisper a secret'],
  },
  {
    // Pages people use: fields, choices, panels
    name: 'ui',
    examples: [
      'Work out my monthly loan payment from the amount and the rate',
      'I need a sign-up sheet for the book club',
      'Make a settings panel with a dark mode switch',
      'Let me keep a shopping list I can add to and cross things off',
      'Give me a BMI checker',
      'Run a quick poll with three choices',
      'I want a habit tracker for the week with checkboxes',
      'Swap euros for dollars for me with a little tool',
      'Make a mortgage estimator',
      'Create a page with tabs for home, about and contact',
      'A volume knob I can turn up and down',
      'Let me rate my day from one to five stars',
      'Scale a recipe up for more people',
      'Tell me how strong my password is as I type it',
    ],
    notFor: ['Paint a field of sunflowers', 'Who painted the Mona Lisa?', 'Play a lullaby on a harp', 'Write a list of fun weekend ideas'],
  },
  {
    // Drawings, animation and games, on a canvas
    name: 'canvas',
    examples: [
      'Paint a night sky full of stars',
      'Set off some fireworks',
      'Show a fish swimming back and forth in a tank',
      'I want a pong game to play against the computer',
      'Draw a smiling sun wearing sunglasses',
      'Make it rain confetti',
      'Simulate a few planets pulled by gravity',
      'Make a spirograph pattern',
      'Show a car driving down a road with trees going by',
      'Let me knock out bricks with a bouncing ball',
      'Generate some abstract art with random circles',
      'Sketch a mountain lake at dawn',
      'Have a flock of birds sweep across the sky',
      'Let me scribble with my mouse',
    ],
    notFor: ['Make a list of my favorite foods', 'Make a simple sign-up sheet', 'Show the days of the week as bars', 'Draw a name out of a hat for the raffle'],
  },
  {
    name: 'three',
    examples: [
      'Show a donut shape turning slowly in space',
      'Make a pyramid I can look at from every side',
      'Build a little room with a table in it that has real depth',
      'Show the earth as a globe rotating',
      'Put a cylinder and a cone side by side in three dimensions',
      'Render a shiny metal ball under a light',
      'Make a maze with walls you can see in perspective',
      'Float some cubes in space at different depths',
      'Make a torus knot',
      'Make a bar graph that stands up off the page',
      'Show a die tumbling around in the air',
      'A spaceship model rotating on a stand',
      'Make a solid crystal shape that catches the light',
    ],
    notFor: ['Draw a flat square', 'Make a side-scrolling platformer', 'Tell me what 3D printing is', 'Make a cube root calculator'],
  },
  {
    // Diagrams, charts and icons in SVG
    name: 'svg',
    examples: [
      'Make a pie chart of how I spend my day',
      'Sketch out a family tree for three generations',
      'Show the steps of photosynthesis as boxes and arrows',
      'Design a paper airplane symbol for my app',
      'Plot the temperatures over the week as a line',
      'Lay out who reports to whom at a small company',
      'Make a simple map of a park with paths',
      'Make a venn diagram of cats and dogs',
      'Plot the numbers 3, 7, 2 and 9 as bars',
      'Make a badge for a hiking club',
      'Show a timeline of the history of flight',
      'Draw a wifi symbol',
      'Make a gauge that reads 70 percent',
    ],
    notFor: ['Paint a watercolor sunset', 'Make a bouncing ball game', 'What is a diagram?', 'Chart a course for my career, in words'],
  },
  {
    name: 'music',
    examples: [
      'Play Ode to Joy',
      'Give me a jazzy bass line',
      'Can you play something sad on the cello?',
      'Play the opening of Für Elise',
      'Make up a little melody on the flute',
      'Lay down a rock groove with a snare and hi-hats',
      'Go through a G major chord progression',
      'Do Jingle Bells on a music box',
      'Hum me a lullaby',
      'Do a funky groove on the electric guitar',
      'Run an arpeggio up and down',
      'Mary Had a Little Lamb on the xylophone, please',
      'Make up a catchy tune',
      'Serenade me on the violin',
    ],
    notFor: ['Who composed the Moonlight Sonata?', 'Make a doorbell ding', 'Write the lyrics for a love song', 'What key is Let It Be in?'],
  },
  {
    // Beeps, tones and noises with Web Audio
    name: 'fx',
    examples: [
      'Make a siren noise',
      'Go ding when it’s done',
      'Give me a game show wrong-answer buzzer',
      'Give me a whoosh noise',
      'Make a sound like a coin being picked up',
      'Make a phone ringing sound',
      'Play a low hum',
      'Sound like a truck reversing',
      'Play some white noise to help me sleep',
      'Play a 440 hertz tone for two seconds',
      'Make a boing noise',
      'Make a sound like a raindrop',
      'Play a short chime',
    ],
    notFor: ['Play a waltz on the piano', 'Write about the sound of the sea', 'Why is thunder so loud?', 'Does that plan sound good?'],
  },
  {
    // Questions about the world, answered or looked up
    name: 'facts',
    examples: [
      'When did the Berlin Wall fall?',
      'Who discovered penicillin?',
      'Tell me something about octopuses',
      'Where is Timbuktu?',
      'What language do they speak in Brazil?',
      'How long do elephants live?',
      'What is the biggest desert in the world?',
      'Give me a short bio of Marie Curie',
      'What does a cardiologist do?',
      'How far is the moon from the earth?',
      'Who is the author of Pride and Prejudice?',
      'I wonder what the tallest building is',
      'Explain how a rainbow forms',
    ],
    notFor: ['What is 9 times 7?', 'Make a quiz about planets', 'Draw the Eiffel Tower', 'Make up a fact-sounding tall tale'],
  },
  {
    // Text from the request, worked on with string methods
    name: 'text',
    examples: [
      'Turn "the quick brown fox" into title case',
      'How many times does the letter e appear in "excellence"?',
      'Flip the order of the words in "one two three four"',
      'Remove all the spaces from "a b c d e"',
      'Put my name, Robert, in all caps',
      'Sort these alphabetically: pear, apple, fig',
      'Does "listen" use the same letters as "silent"?',
      'Turn "hello there" into pig latin',
      'Make "SHOUTING TEXT" quiet',
      'Which is longest in "a tiny elephant danced"?',
      'Swap every space for a dash in "my new file name"',
      'Give me the initials of "John Ronald Reuel Tolkien"',
      'Spell "giraffe" backwards',
    ],
    notFor: ['Write a haiku about the moon', 'Draw the word love in big letters', 'Tell me a fun word', 'Play a song backwards'],
  },
  {
    // Played with the keyboard
    name: 'keys',
    examples: [
      'A snake I steer with the arrows',
      'Let me move a spaceship left and right and shoot with space',
      'Test how fast I can type',
      'Show which letter I hit in big print',
      'Make a maze I can walk through with WASD',
      'A dinosaur that hops whenever I hit space',
      'Let me play a piano with the letters on my laptop',
      'Make a game where I dodge falling rocks going left and right',
      'Get a frog across the road with the arrows',
      'Let me drive a tank around',
      'Letters fall and I type them before they land',
      'A paddle I slide up and down to block a ball',
    ],
    notFor: ['What key is this song in?', 'Give me the key points of the article', 'Draw a house key', 'Make a piano I tap on screen'],
  },
  {
    // Page elements that move or change by CSS
    name: 'css',
    examples: [
      'Make the headline gently bounce',
      'Have a message appear slowly out of nowhere',
      'Make a card that flips over when I point at it',
      'Spin a loading circle',
      'Make the letters of my name wave one by one',
      'Make the background shift through colors smoothly',
      'Have a menu drop down from the top',
      'Have the signup button wobble to get attention',
      'Have the picture zoom in a little when I point at it',
      'Make a notification pop in and then disappear',
      'Make the text glow like neon',
      'Have the boxes appear one after another',
      'Make a progress bar fill up smoothly',
    ],
    notFor: ['Animate a bouncing ball with physics on a canvas', 'A tale of a star that slowly goes dark', 'Make the text bold', 'How do fireflies glow?'],
  },
  {
    // Kept between visits in localStorage
    name: 'save',
    examples: [
      'Make a journal that keeps my entries',
      'Let me write a reminder and have it there tomorrow',
      'Make a reading log that doesn’t forget my books',
      'Hold on to my favorite color for later',
      'Make a scratch pad that holds onto my text when I close it',
      'Track how many cups of coffee I have had, even after a refresh',
      'Make a bookmarks list that sticks around',
      'Don’t lose which tasks I checked off',
      'Let me jot down ideas and find them again next week',
      'Hang on to the last city I typed',
      'Make a goal tracker that picks up where I left off',
      'Hold my best quiz score for next time',
      'Keep my packing list until I clear it',
    ],
    notFor: ['Save the princess in a platform game', 'Remember the Alamo, tell me what happened', 'Draw a piggy bank for saving money', 'Make a memory matching game'],
  },
  {
    // The weather now, through getWeather
    name: 'weather',
    examples: [
      'Will I need sunglasses in Phoenix this afternoon?',
      'How chilly is it in Oslo?',
      'Is it a good day for a picnic in Paris?',
      'Should I bring an umbrella to work?',
      'What’s it like outside in Tokyo right now?',
      'Is it snowing in Denver?',
      'How warm is it in Sydney today?',
      'Is it windy in Chicago?',
      'Will it be freezing in Toronto tonight?',
      'Is the sky clear in Lisbon?',
      'Can I wear shorts in Miami today?',
      'Tell me the conditions in Cape Town',
      'Is it nice out where I am?',
    ],
    notFor: ['Draw a thunderstorm over the sea', 'Why does it rain?', 'A poem about sunshine on the porch', 'Make a snow globe that shakes'],
  },
  {
    // JSON from a web address
    name: 'fetch',
    examples: [
      'How many forks does https://gitlab.com/api/v4/projects/278964 report?',
      'Pull the post at https://dummyjson.com/posts/1 and put its heading on screen',
      'What’s my public IP? Ask the ipify service for it as JSON',
      'Show a made-up person from https://randomuser.me/api/',
      'Name the breed of a random pup from the Dog CEO image service',
      'Load the numbers from https://example.com/data.json and add them up',
      'Use the Open Library search to find books about whales',
      'Check https://api.nationalize.io?name=sarah and say which country it guesses',
      'Grab the newest Hacker News story from their API',
      'Look up the country info for Peru from the REST Countries service',
      'Show what https://httpbin.org/get sends back',
      'Pull today’s euro exchange rate from a currency API',
    ],
    notFor: ['Throw a stick for my puppy to fetch', 'Show this photo: https://example.com/cat.jpg', 'What is a web address?', 'Got any good jokes?'],
  },
  {
    // Text put on the clipboard after a click
    name: 'clipboard',
    examples: [
      'Put my email address on the clipboard with one button',
      'Pick a random hex color I can copy with one tap',
      'Turn my text into a URL slug I can grab',
      'Make a lorem ipsum generator with a copy button',
      'Make a box of emoji I can tap to copy',
      'Let me grab the generated username with a button',
      'Create a link shortener mockup with a copy link button',
      'Generate a strong passphrase and let me copy it',
      'Show a code snippet with a button to copy the code',
      'Make a signature line I can drop into emails',
      'Turn my sentence into hashtags ready for social media',
      'A field for QR code text and a button to copy it',
    ],
    notFor: ['Copy the style of Picasso in a drawing', 'Draw two circles, the second one copied from the first', 'A fable about a copycat kitten', 'Make toothpaste coupons'],
  },
];
