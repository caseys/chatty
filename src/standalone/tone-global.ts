// Tone.js as the global Tone, on Chatty's audio (see tone-realm.ts). Loaded into the page of a
// program that uses Tone, and inlined in a downloaded one. The imports run in this order: the host's
// audio constructors are lent, Tone's global context is made the app's, then Tone evaluates.
import { restoreWindowAudio } from './tone-realm.ts';
import './tone-context.ts';
import * as Tone from 'tone';

restoreWindowAudio();
(window as unknown as { Tone: unknown }).Tone = Tone;
