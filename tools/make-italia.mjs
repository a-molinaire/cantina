// Genera assets/italia.json (sagome delle regioni + punto per l'etichetta) per la mappa delle statistiche.
// Fonte: confini regionali Openpolis (https://github.com/openpolis/geojson-italy), semplificati con mapshaper:
//   npx mapshaper@0.6.102 limits_IT_regions.geojson -proj EPSG:32632 -simplify 1.5% keep-shapes \
//     -filter-fields reg_istat_code,reg_name -o regioni-proj.json format=geojson precision=1 \
//     -points inner -o centri-proj.json format=geojson precision=1
// Uso: node tools/make-italia.mjs regioni-proj.json centri-proj.json
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const [fileRegioni, fileCentri] = process.argv.slice(2);
const regioni = JSON.parse(readFileSync(fileRegioni, 'utf8')).features;
const centri = JSON.parse(readFileSync(fileCentri, 'utf8')).features;

const LARGHEZZA = 400;
const punti = regioni.flatMap(f => (f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates).flat(2));
const minX = Math.min(...punti.map(p => p[0])), maxX = Math.max(...punti.map(p => p[0]));
const minY = Math.min(...punti.map(p => p[1])), maxY = Math.max(...punti.map(p => p[1]));
const scala = LARGHEZZA / (maxX - minX);
const altezza = Math.round((maxY - minY) * scala);
const xy = ([x, y]) => [((x - minX) * scala).toFixed(1), ((maxY - y) * scala).toFixed(1)];

const percorso = geometry => {
  const poligoni = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  return poligoni.map(anelli => anelli.map(anello => 'M' + anello.map(p => xy(p).join(' ')).join('L') + 'Z').join('')).join('');
};

const out = {
  fonte: 'Openpolis geojson-italy, semplificato',
  larghezza: LARGHEZZA,
  altezza,
  regioni: regioni.map(f => {
    const c = centri.find(p => p.properties.reg_istat_code === f.properties.reg_istat_code);
    const [x, y] = xy(c.geometry.coordinates).map(Number);
    return { codice: f.properties.reg_istat_code, nome: f.properties.reg_name, d: percorso(f.geometry), x, y };
  }),
};

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(root, 'assets'), { recursive: true });
writeFileSync(join(root, 'assets', 'italia.json'), JSON.stringify(out));
console.log(`assets/italia.json: ${out.regioni.length} regioni, ${LARGHEZZA}x${altezza}, ${JSON.stringify(out).length} byte`);
