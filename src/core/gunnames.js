'use strict';
// Which gun a sound bank is for. GTA names the banks in WEAPONS_PLAYER.rpf after the
// weapon (ptl_pistol, ptl_combat, ptl_50cal, smg_micro, ...); pack makers mostly keep
// those names. The most specific match wins, so this list is ordered.

const RULES = [
  // pistols
  [/(^|_)(ptl_)?50(cal)?($|_)|pistol_?50/, 'Pistol .50'],
  [/heavy_?pistol|ptl_heavy|ptl_hvy/, 'Heavy Pistol'],
  [/double_?action/, 'Double-Action Revolver'],
  [/navy/, 'Navy Revolver'],
  [/revolver|(^|_)rvl/, 'Heavy Revolver'],
  [/(^|_)sns/, 'SNS Pistol'],
  [/vintage|(^|_)vtg/, 'Vintage Pistol'],
  [/ptl_ap|ap_?pistol/, 'AP Pistol'],
  [/ceramic/, 'Ceramic Pistol'],
  [/perico|gadget/, 'Perico Pistol'],
  [/atomizer|ray_?pistol/, 'Up-n-Atomizer'],
  [/flare/, 'Flare Gun'],
  [/(^|_)stun(_?gun)?($|_)/, 'Stun Gun'],
  [/marksman_?pistol|ptl_marksman/, 'Marksman Pistol'],
  [/ptl_combat|combat_?pistol/, 'Combat Pistol'],
  // SMGs
  [/micro/, 'Micro SMG'],
  [/mini_?smg/, 'Mini SMG'],
  [/machine_?pistol/, 'Machine Pistol'],
  [/pdw/, 'Combat PDW'],
  [/gusenberg/, 'Gusenberg Sweeper'],
  [/assault_?smg|smg_assault/, 'Assault SMG'],
  [/(^|_)smg/, 'SMG'],
  // shotguns
  [/sawn?_?off|sawed/, 'Sawed-Off Shotgun'],
  [/(bullpup.*(sht|shot))|((sht|shot).*bullpup)/, 'Bullpup Shotgun'],
  [/(assault.*(sht|shot))|((sht|shot).*assault)/, 'Assault Shotgun'],
  [/(heavy.*(sht|shot))|((sht|shot).*heavy)/, 'Heavy Shotgun'],
  [/(combat.*(sht|shot))|((sht|shot).*combat)/, 'Combat Shotgun'],
  [/musket/, 'Musket'],
  [/double_?barrel|dbshot/, 'Double Barrel Shotgun'],
  [/auto_?shotgun|sweeper/, 'Sweeper Shotgun'],
  [/pump|(^|_)sht|shotgun/, 'Pump Shotgun'],
  // snipers
  [/(heavy.*(snp|sniper))|((snp|sniper).*heavy)/, 'Heavy Sniper'],
  [/marksman/, 'Marksman Rifle'],
  [/precision/, 'Precision Rifle'],
  [/(^|_)snp|sniper/, 'Sniper Rifle'],
  // rifles
  [/special_?carbine/, 'Special Carbine'],
  [/(bullpup.*rif)|(rif.*bullpup)/, 'Bullpup Rifle'],
  [/(compact.*rif)|(rif.*compact)/, 'Compact Rifle'],
  [/(advanced.*rif)|(rif.*adv)/, 'Advanced Rifle'],
  [/military/, 'Military Rifle'],
  [/heavy_?rifle/, 'Heavy Rifle'],
  [/tactical_?rifle|service_?carbine/, 'Service Carbine'],
  [/carbine/, 'Carbine Rifle'],
  [/(assault.*rif)|(rif.*assault)|(^|_)ak(47)?($|_)/, 'Assault Rifle'],
  // machine guns and heavy weapons
  [/(combat.*mg)|(mg.*combat)/, 'Combat MG'],
  [/minigun/, 'Minigun'],
  [/(^|_)lmg|(^|_)mg($|_)/, 'MG'],
  [/rpg|rocket/, 'RPG'],
  [/grenade_?launcher|(^|_)gl_/, 'Grenade Launcher'],
  [/railgun/, 'Railgun'],
  [/homing/, 'Homing Launcher'],
  [/firework/, 'Firework Launcher'],
  [/grenade/, 'Grenade'],
  // plain fallbacks
  [/(^|_)ptl|pistol/, 'Pistol'],
  [/rifle|(^|_)rfl/, 'Rifle'],
];

// Parts of a gun's sound, when the bank name says it.
const PARTS = [
  [/silenc|suppress/, 'suppressed'],
  [/reload/, 'reload'],
  [/shell|casing/, 'shell casings'],
  [/(^|_)(tail|echo|distant)/, 'echo'],
  [/npc|_ai($|_)/, 'other players'],
];

/** "ptl_combat" -> "Combat Pistol", "smg_micro_silenced" -> "Micro SMG (suppressed)", unknown -> null */
function gunName(bankName) {
  const n = String(bankName || '').toLowerCase().replace(/\.awc$/, '').replace(/[\s-]+/g, '_');
  const hit = RULES.find(([re]) => re.test(n));
  if (!hit) return null;
  const parts = PARTS.filter(([re]) => re.test(n)).map(([, p]) => p);
  return hit[1] + (parts.length ? ' (' + parts.join(', ') + ')' : '');
}

// Single sounds inside RESIDENT.rpf/weapons.awc, which only has numbered names.
// From the GTAForums gun sounds modding thread; Rockstar has renumbered some in updates.
const KNOWN_STREAMS = { 0x0f4dfcd5: 'Pistol', 0x1e5a3aed: 'Combat Pistol', 0x02603040: 'Pump Shotgun' };

function streamName(id) {
  return KNOWN_STREAMS[id >>> 0] || null;
}

module.exports = { gunName, streamName };
