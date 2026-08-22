import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { skillName, listVaultSkillNames } from './vault-skills';

function vaultWithSkills(skills: Record<string, string | null>) {
  const d = mkdtempSync(join(tmpdir(), 'akira-vs-'));
  for (const [dir, body] of Object.entries(skills)) {
    mkdirSync(join(d, 'skills', dir), { recursive: true });
    if (body !== null) writeFileSync(join(d, 'skills', dir, 'SKILL.md'), body);
  }
  return d;
}

const skill = (name: string) => `---\nname: ${name}\ndescription: does a thing\n---\n\n# Body\n`;

test('skillName reads the frontmatter name', () => {
  assert.equal(skillName(skill('vault-gardening')), 'vault-gardening');
  assert.equal(skillName('---\r\nname: crlf-skill\r\n---\r\nbody'), 'crlf-skill', 'CRLF frontmatter parses');
  assert.equal(skillName('---\nname: "quoted"\n---\nb'), 'quoted', 'quotes are stripped');
});

test('skillName returns empty for no frontmatter and no name', () => {
  assert.equal(skillName('# Just a heading'), '');
  assert.equal(skillName('---\ndescription: no name here\n---\nb'), '');
});

test('lists the vault skills by their declared names', () => {
  const d = vaultWithSkills({ 'vault-gardening': skill('vault-gardening'), 'distil-research': skill('distil-research') });
  try {
    assert.deepEqual(listVaultSkillNames(d).sort(), ['distil-research', 'vault-gardening']);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('falls back to the directory name when frontmatter has none', () => {
  const d = vaultWithSkills({ 'no-name': '# no frontmatter' });
  try {
    assert.deepEqual(listVaultSkillNames(d), ['no-name']);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('ignores a folder with no SKILL.md', () => {
  const d = vaultWithSkills({ 'real-skill': skill('real-skill'), 'just-a-folder': null });
  try {
    assert.deepEqual(listVaultSkillNames(d), ['real-skill']);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('returns empty (never throws) when the skills zone is absent', () => {
  const d = mkdtempSync(join(tmpdir(), 'akira-vs-empty-'));
  try {
    assert.deepEqual(listVaultSkillNames(d), []);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('a skill she authors later shows up on the next read', () => {
  const d = vaultWithSkills({ 'vault-gardening': skill('vault-gardening') });
  try {
    assert.deepEqual(listVaultSkillNames(d), ['vault-gardening']);
    mkdirSync(join(d, 'skills', 'brief-writing'), { recursive: true });
    writeFileSync(join(d, 'skills', 'brief-writing', 'SKILL.md'), skill('brief-writing'));
    assert.deepEqual(listVaultSkillNames(d).sort(), ['brief-writing', 'vault-gardening']);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
