#!/usr/bin/env node
'use strict';

// Structural comparison of the CDK-synthesized template against the original
// hand-written reference. Confirms the two share the same Parameters, Conditions,
// Mappings, Resources (logical id + type), and Outputs (logical id + export name).
//
// Exact byte match is NOT expected: CDK emits long-form intrinsics (Ref:/Fn::Sub:)
// and orders keys differently. This checks the invariants that make the generated
// template a drop-in for the deployed stack.

const fs = require('fs');
const yaml = require('js-yaml');

const [, , originalPath, generatedPath] = process.argv;
if (!originalPath || !generatedPath) {
  console.error('usage: compare-templates.js <original.yaml> <generated.json>');
  process.exit(2);
}

// Map CloudFormation short tags (!Ref, !Sub, ...) to their long form so the
// parsed original matches the shape CDK emits in JSON.
const TAGS = [
  'Ref',
  'Sub',
  'GetAtt',
  'Select',
  'GetAZs',
  'FindInMap',
  'Equals',
  'Not',
  'And',
  'Or',
  'If',
  'Base64',
  'Join',
  'Split',
  'Cidr',
  'ImportValue',
];
const buildType = (name, kind) =>
  new yaml.Type(`!${name}`, {
    kind,
    construct: (data) => {
      if (name === 'Ref') return { Ref: data };
      if (name === 'GetAtt') {
        return { 'Fn::GetAtt': typeof data === 'string' ? data.split('.') : data };
      }
      return { [`Fn::${name}`]: data };
    },
  });
const types = [];
for (const name of TAGS) {
  for (const kind of ['scalar', 'sequence', 'mapping']) {
    types.push(buildType(name, kind));
  }
}
const schema = yaml.DEFAULT_SCHEMA.extend(types);

const original = yaml.load(fs.readFileSync(originalPath, 'utf8'), { schema });
const generated = JSON.parse(fs.readFileSync(generatedPath, 'utf8'));

let failures = 0;
const report = (label, a, b) => {
  const sa = new Set(a);
  const sb = new Set(b);
  const onlyA = [...sa].filter((x) => !sb.has(x));
  const onlyB = [...sb].filter((x) => !sa.has(x));
  if (onlyA.length || onlyB.length) {
    failures++;
    console.log(`  [DIFF] ${label}`);
    if (onlyA.length) console.log(`      only in original : ${onlyA.join(', ')}`);
    if (onlyB.length) console.log(`      only in generated: ${onlyB.join(', ')}`);
  } else {
    console.log(`  [OK]   ${label} (${sa.size})`);
  }
};

const keys = (obj, section) => Object.keys((obj && obj[section]) || {});
report('Parameters', keys(original, 'Parameters'), keys(generated, 'Parameters'));
report('Conditions', keys(original, 'Conditions'), keys(generated, 'Conditions'));
report('Mappings', keys(original, 'Mappings'), keys(generated, 'Mappings'));

const resTypes = (obj) => Object.entries((obj && obj.Resources) || {}).map(([k, v]) => `${k}:${v.Type}`);
report('Resources (id:type)', resTypes(original), resTypes(generated));

const exportName = (out) => {
  const n = out && out.Export && out.Export.Name;
  if (!n) return '';
  if (typeof n === 'string') return n;
  if (n['Fn::Sub']) return n['Fn::Sub'];
  return JSON.stringify(n);
};
const outs = (obj) => Object.entries((obj && obj.Outputs) || {}).map(([k, v]) => `${k}=>${exportName(v)}`);
report('Outputs (id=>export)', outs(original), outs(generated));

console.log('');
if (failures) {
  console.log(`Structural differences found in ${failures} section(s).`);
  process.exit(1);
}
console.log('Templates are structurally equivalent (parameters, conditions, mappings, resources, outputs).');
