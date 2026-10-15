// Starter templates of the canvas (H1), written for Oriel: storyboard, moodboard, shooting plan and
// simple Gantt chart. Each returns plain objects laid out from (0, 0), frames first (below).
import { positionsBetween, type CanvasColor, type CanvasObject } from '@oriel/shared';
import { cid, makeFrame, makeNote, makeShape, makeText } from './model';

export interface CanvasTemplate {
  id: 'storyboard' | 'moodboard' | 'shooting' | 'gantt';
  name: string;
  description: string;
  build: () => CanvasObject[];
}

/** z keys for `n` objects in creation order. */
const zs = (n: number) => positionsBetween(null, null, n);

function storyboard(): CanvasObject[] {
  const out: Array<Omit<CanvasObject, 'z'> & { z?: string }> = [];
  const order = zs(6);
  out.push(makeText({ x: 0, y: -90, z: 'a0', text: 'Storyboard — titre du projet', fontSize: 'xl', bold: true, w: 900, h: 56 }));
  for (let i = 0; i < 6; i++) {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const x = col * 440;
    const y = row * 420;
    const groupId = cid();
    out.push(makeFrame({ x: x - 20, y: y - 20, w: 420, h: 390, z: 'a0', name: `Plan ${i + 1}`, order: order[i]! }));
    out.push(makeShape({ x, y, w: 380, h: 214, z: 'a0', shape: 'rect', fill: 'gray', stroke: 'gray', strokeWidth: 1, text: 'Image du plan', textColor: 'gray', fontSize: 's', groupId }));
    out.push(makeText({ x, y: y + 226, z: 'a0', text: `Plan ${i + 1} · Plan large · 4 s`, fontSize: 's', bold: true, w: 380, h: 26, groupId }));
    out.push(makeText({ x, y: y + 254, z: 'a0', text: 'Action : …\nSon / dialogue : …', fontSize: 's', w: 380, h: 56, color: 'gray', groupId }));
  }
  return withZ(out);
}

function moodboard(): CanvasObject[] {
  const out: Array<Omit<CanvasObject, 'z'> & { z?: string }> = [];
  out.push(makeFrame({ x: -40, y: -120, w: 1240, h: 900, z: 'a0', name: 'Moodboard', order: zs(1)[0]! }));
  out.push(makeText({ x: 0, y: -90, z: 'a0', text: 'Moodboard — intentions', fontSize: 'xl', bold: true, w: 900, h: 56 }));
  const cells: Array<[number, number, number, number, CanvasColor, string]> = [
    [0, 0, 380, 260, 'blue', 'Lumière'],
    [400, 0, 260, 380, 'orange', 'Couleurs'],
    [680, 0, 480, 260, 'green', 'Décors'],
    [0, 280, 380, 400, 'purple', 'Costumes'],
    [680, 280, 230, 200, 'pink', 'Textures'],
    [930, 280, 230, 200, 'yellow', 'Typographie'],
  ];
  for (const [x, y, w, h, c, label] of cells) {
    out.push(makeShape({ x, y, w, h, z: 'a0', shape: 'rect', fill: c, stroke: c, strokeWidth: 0, text: `${label}\n(glissez une image ici)`, textColor: 'gray', fontSize: 's' }));
  }
  out.push(makeNote({ x: 400, y: 400, w: 260, h: 180, z: 'a0', fill: 'yellow', text: '# Références\n- Film, photographe…\n- Ambiance sonore' }));
  out.push(makeNote({ x: 680, y: 500, w: 480, h: 180, z: 'a0', fill: 'gray', text: '# À éviter\n- …' }));
  return withZ(out);
}

function shooting(): CanvasObject[] {
  const out: Array<Omit<CanvasObject, 'z'> & { z?: string }> = [];
  out.push(makeText({ x: 0, y: -90, z: 'a0', text: 'Plan de tournage — jour 1', fontSize: 'xl', bold: true, w: 900, h: 56 }));
  const cols = ['Horaire', 'Séquence', 'Lieu', 'Équipe / comédiens', 'Matériel'];
  const widths = [140, 300, 220, 260, 220];
  const rows = [
    ['08:00', 'Installation et lumière', 'Atelier', 'Image, électro', 'Projecteurs LED'],
    ['09:30', 'Séq. 1 — interview', 'Atelier', 'Réal., son, invité', 'Caméra A + B, micros cravate'],
    ['12:30', 'Pause', '—', 'Tous', '—'],
    ['13:30', 'Séq. 2 — plans d’illustration', 'Extérieur', 'Image', 'Stabilisateur'],
    ['16:00', 'Séq. 3 — témoignages', 'Bureau', 'Réal., son', 'Caméra A'],
  ];
  let x = 0;
  cols.forEach((label, i) => {
    out.push(makeShape({ x, y: 0, w: widths[i]!, h: 44, z: 'a0', shape: 'rect', fill: 'blue', stroke: 'blue', strokeWidth: 1, text: label, fontSize: 's' }));
    rows.forEach((row, r) => {
      out.push(
        makeShape({ x, y: 44 + r * 64, w: widths[i]!, h: 64, z: 'a0', shape: 'rect', fill: r === 2 ? 'gray' : 'none', stroke: 'gray', strokeWidth: 1, text: row[i]!, fontSize: 's' }),
      );
    });
    x += widths[i]!;
  });
  out.push(makeNote({ x: x + 40, y: 0, w: 260, h: 200, z: 'a0', fill: 'yellow', text: '# Contacts\n- Production : …\n- Lieu : …\n[ ] Autorisations' }));
  return withZ(out);
}

function gantt(): CanvasObject[] {
  const out: Array<Omit<CanvasObject, 'z'> & { z?: string }> = [];
  out.push(makeText({ x: 0, y: -90, z: 'a0', text: 'Rétroplanning', fontSize: 'xl', bold: true, w: 900, h: 56 }));
  const weeks = 8;
  const colW = 110;
  const left = 220;
  for (let w = 0; w < weeks; w++) {
    out.push(makeShape({ x: left + w * colW, y: 0, w: colW, h: 36, z: 'a0', shape: 'rect', fill: 'gray', stroke: 'gray', strokeWidth: 1, text: `S${w + 1}`, fontSize: 's' }));
  }
  const tasks: Array<[string, number, number, CanvasColor]> = [
    ['Écriture', 0, 2, 'purple'],
    ['Préproduction', 1, 3, 'blue'],
    ['Repérages', 2, 1, 'green'],
    ['Tournage', 3, 2, 'orange'],
    ['Montage', 5, 2, 'pink'],
    ['Étalonnage et mixage', 6, 1, 'yellow'],
    ['Livraison', 7, 1, 'red'],
  ];
  tasks.forEach(([label, start, len, c], i) => {
    const y = 48 + i * 52;
    out.push(makeText({ x: 0, y: y + 6, z: 'a0', text: label, fontSize: 's', bold: true, w: left - 16, h: 28 }));
    out.push(makeShape({ x: left + start * colW + 4, y, w: len * colW - 8, h: 40, z: 'a0', shape: 'rounded', fill: c, stroke: c, strokeWidth: 1, text: '', fontSize: 's' }));
  });
  out.push(
    makeShape({ x: left - 4, y: 40, w: weeks * colW + 8, h: tasks.length * 52 + 8, z: 'a0', shape: 'rect', fill: 'none', stroke: 'gray', strokeWidth: 1, dash: 'dashed', text: '', fontSize: 's' }),
  );
  return withZ(out);
}

/** Frames below everything, then the other objects in creation order. */
function withZ(list: Array<Omit<CanvasObject, 'z'> & { z?: string }>): CanvasObject[] {
  const frames = list.filter((o) => o.type === 'frame');
  const rest = list.filter((o) => o.type !== 'frame');
  const keys = zs(frames.length + rest.length);
  return [...frames, ...rest].map((o, i) => ({ ...o, z: keys[i]! }) as CanvasObject);
}

export const CANVAS_TEMPLATES: CanvasTemplate[] = [
  { id: 'storyboard', name: 'Storyboard', description: 'Six plans avec image, cadrage, durée et action', build: storyboard },
  { id: 'moodboard', name: 'Moodboard', description: 'Grille de références visuelles et notes', build: moodboard },
  { id: 'shooting', name: 'Plan de tournage', description: 'Horaires, séquences, lieux, équipe et matériel', build: shooting },
  { id: 'gantt', name: 'Gantt simple', description: 'Rétroplanning sur huit semaines', build: gantt },
];
