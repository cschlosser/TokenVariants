import { TVA_CONFIG } from '../settings.js';
import { TVASprite } from '../sprite/TVASprite.js';
import { waitForTokenTexture } from '../utils.js';
import { getAllEffectMappings, getTokenEffects } from './effects.js';

export async function drawOverlays(token) {
  if (token.tva_drawing_overlays) return;
  token.tva_drawing_overlays = true;

  const mappings = getAllEffectMappings(token);
  let filteredOverlays = getTokenEffects(token, true);

  filteredOverlays = filteredOverlays
    .filter((ef) => ef in mappings && mappings[ef].overlay)
    .sort((ef1, ef2) => mappings[ef1].priority - mappings[ef2].priority)
    .map((ef) => {
      const overlayConfig = mappings[ef].overlayConfig ?? {};
      overlayConfig.effect = ef;
      return overlayConfig;
    });

  // See if the whole stack or just top of the stack should be used according to settings
  let overlays = [];
  if (filteredOverlays.length) {
    overlays = TVA_CONFIG.stackStatusConfig ? filteredOverlays : [filteredOverlays[filteredOverlays.length - 1]];
  }

  if (overlays.length) {
    waitForTokenTexture(token, async (token) => {
      if (!token.tva_sprites) token.tva_sprites = [];
      // Temporarily mark every overlay for removal.
      // We'll only keep overlays that are still applicable to the token
      _markAllOverlaysForRemoval(token);

      // To keep track of the overlay order
      let sort = (token.document.sort || 0) + 1;
      for (const ov of overlays) {
        let sprite = _findTVASprite(ov.effect, token);
        if (sprite) {
          if (!isEmpty(diffObject(sprite.tvaOverlayConfig, ov))) {
            if (ov.img?.includes('*') || (ov.img?.includes('{') && ov.img?.includes('}'))) {
              sprite.refresh(ov);
            } else if (sprite.tvaOverlayConfig.img !== ov.img || !objectsEqual(sprite.tvaOverlayConfig.text, ov.text)) {
              canvas.primary.removeChild(sprite)?.destroy();
              sprite = canvas.primary.addChild(await _drawEffectOverlay(token, ov));
              token.tva_sprites.push(sprite);
            } else {
              sprite.refresh(ov);
            }
          }
        } else {
          sprite = canvas.primary.addChild(await _drawEffectOverlay(token, ov));
          token.tva_sprites.push(sprite);
        }
        sprite.tvaRemove = false; // Sprite in use, do not remove

        // Assign order to the overlay
        if (sprite.tvaOverlayConfig.underlay) {
          sprite.overlaySort = sort - 100;
        } else {
          sprite.overlaySort = sort;
        }
        sort += 1;
      }

      _removeMarkedOverlays(token);
      token.tva_drawing_overlays = false;
    });
  } else {
    _removeAllOverlays(token);
    token.tva_drawing_overlays = false;
  }
}

async function _drawEffectOverlay(token, conf) {
  if (conf.img?.trim()) {
    let img = conf.img;
    if (conf.img.includes('*') || (conf.img.includes('{') && conf.img.includes('}'))) {
      const images = await wildcardImageSearch(conf.img);
      if (images.length) {
        if (images.length) {
          img = images[Math.floor(Math.random() * images.length)];
        }
      }
    }

    const texture = await loadTexture(img, {
      fallback: 'modules/token-variants/img/token-images.svg',
    });
    return new TVASprite(texture, token, conf);
  } else if (conf.text?.text.trim()) {
    const texture = generateTextTexture(token, conf);
    const sprite = new TVASprite(texture, token, conf);
    sprite.isGenText = true;
    return sprite;
  } else {
    return new TVASprite(await loadTexture('modules/token-variants/img/token-images.svg'), token, conf);
  }
}

export function generateTextTexture(token, conf) {
  let re = new RegExp('{{.*}}');
  let label = conf.text.text.replace(re, function replace(match) {
    const property = match.substring(2, match.length - 2);
    if (property === 'effect') return conf.effect;
    let val = getProperty(token.document ?? token, property);
    return val === undefined ? match : val;
  });

  let text = new PreciseText(label, PreciseText.getTextStyle(conf.text));
  text.updateText(false);

  if (!conf.text.curve?.radius) {
    return text.texture;
  }

  // Curve
  const curve = conf.text.curve;
  const radius = curve.radius;
  const maxRopePoints = 100;
  const step = Math.PI / maxRopePoints;

  let ropePoints = maxRopePoints - Math.round((text.texture.width / (radius * Math.PI)) * maxRopePoints);
  ropePoints /= 2;

  const points = [];
  for (let i = maxRopePoints - ropePoints; i > ropePoints; i--) {
    const x = radius * Math.cos(step * i);
    const y = radius * Math.sin(step * i);
    points.push(new PIXI.Point(x, curve.invert ? y : -y));
  }

  const container = new PIXI.Container();
  const rope = new PIXI.SimpleRope(text.texture, points);
  container.addChild(rope);
  const bounds = container.getLocalBounds();
  const matrix = new PIXI.Matrix();
  matrix.tx = -bounds.x;
  matrix.ty = -bounds.y;

  const renderTexture = PIXI.RenderTexture.create({ width: bounds.width, height: bounds.height, resolution: 2 });
  // const renderTexture = PIXI.RenderTexture.create(bounds.width, bounds.height);
  canvas.app.renderer.render(container, renderTexture, true, matrix, false);
  text.destroy();

  return renderTexture;
}

function _markAllOverlaysForRemoval(token) {
  for (const child of token.tva_sprites) {
    if (child instanceof TVASprite) {
      child.tvaRemove = true;
    }
  }
}

function _removeMarkedOverlays(token) {
  const sprites = [];
  for (const child of token.tva_sprites) {
    if (child.tvaRemove) {
      canvas.primary.removeChild(child)?.destroy();
    } else {
      sprites.push(child);
    }
  }
  token.tva_sprites = sprites;
}

function _findTVASprite(effect, token) {
  for (const child of token.tva_sprites) {
    if (child.tvaOverlayConfig?.effect === effect) {
      return child;
    }
  }
  return null;
}

function _removeAllOverlays(token) {
  if (token.tva_sprites)
    for (const child of token.tva_sprites) {
      canvas.primary.removeChild(child)?.destroy();
    }
  token.tva_sprites = null;
}

export function broadcastOverlayRedraw(token) {
  // Need to broadcast to other users to re-draw the overlay
  drawOverlays(token.object ?? token);
  const message = {
    handlerName: 'drawOverlays',
    args: { tokenId: token.id },
    type: 'UPDATE',
  };
  game.socket?.emit('module.token-variants', message);
}
