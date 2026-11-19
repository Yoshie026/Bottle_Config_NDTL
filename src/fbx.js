// Minimal binary FBX 7.4 writer: meshes with normals and UVs, Phong materials, and textures
// embedded in the file (so the .fbx is self-contained). Units are millimetres, Y up.

const enc = new TextEncoder()

// Property helpers ------------------------------------------------------------------------------
const S = (v) => ({ t: 'S', v })
const I = (v) => ({ t: 'I', v })
const L = (v) => ({ t: 'L', v })
const D = (v) => ({ t: 'D', v })
const C = (v) => ({ t: 'C', v })
const R = (v) => ({ t: 'R', v })
const ARR_D = (v) => ({ t: 'd', v: v instanceof Float64Array ? v : Float64Array.from(v) })
const ARR_I = (v) => ({ t: 'i', v: v instanceof Int32Array ? v : Int32Array.from(v) })

const node = (name, props = [], children = []) => ({ name, props, children })
// Properties70 entry: P "name" "type" "label" "flags" ...values
const P = (name, type, label, flags, ...values) => node('P', [S(name), S(type), S(label), S(flags), ...values])

async function deflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

// Encode property values; large arrays are zlib-compressed.
async function encodeProps(props) {
  const parts = []
  for (const { t, v } of props) {
    if (t === 'S' || t === 'R') {
      const bytes = t === 'S' ? enc.encode(v) : v
      const head = new DataView(new ArrayBuffer(5))
      head.setUint8(0, t.charCodeAt(0))
      head.setUint32(1, bytes.length, true)
      parts.push(new Uint8Array(head.buffer), bytes)
    } else if (t === 'd' || t === 'i') {
      const raw = new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
      const compress = raw.length > 1024
      const data = compress ? await deflate(raw) : raw
      const head = new DataView(new ArrayBuffer(13))
      head.setUint8(0, t.charCodeAt(0))
      head.setUint32(1, v.length, true)
      head.setUint32(5, compress ? 1 : 0, true)
      head.setUint32(9, data.length, true)
      parts.push(new Uint8Array(head.buffer), data)
    } else {
      const size = { I: 4, L: 8, D: 8, C: 1 }[t]
      const view = new DataView(new ArrayBuffer(1 + size))
      view.setUint8(0, t.charCodeAt(0))
      if (t === 'I') view.setInt32(1, v, true)
      if (t === 'L') view.setBigInt64(1, BigInt(v), true)
      if (t === 'D') view.setFloat64(1, v, true)
      if (t === 'C') view.setUint8(1, v ? 1 : 0)
      parts.push(new Uint8Array(view.buffer))
    }
  }
  return parts
}

const concat = (chunks) => {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
  let o = 0
  for (const c of chunks) {
    out.set(c, o)
    o += c.length
  }
  return out
}

const NULL_RECORD = new Uint8Array(13)

// Node record: endOffset, numProperties, propertyListLen, nameLen, name, props, children, sentinel.
async function encodeNode(n, offset) {
  const props = concat(await encodeProps(n.props))
  const name = enc.encode(n.name)
  const headerLen = 13 + name.length
  let cursor = offset + headerLen + props.length
  const children = []
  for (const child of n.children) {
    const bytes = await encodeNode(child, cursor)
    children.push(bytes)
    cursor += bytes.length
  }
  if (n.children.length) {
    children.push(NULL_RECORD)
    cursor += 13
  }
  const head = new DataView(new ArrayBuffer(headerLen))
  head.setUint32(0, cursor, true)
  head.setUint32(4, n.props.length, true)
  head.setUint32(8, props.length, true)
  head.setUint8(12, name.length)
  new Uint8Array(head.buffer).set(name, 13)
  return concat([new Uint8Array(head.buffer), props, ...children])
}

async function encodeFile(nodes) {
  const header = concat([enc.encode('Kaydara FBX Binary  '), new Uint8Array([0x00, 0x1a, 0x00])])
  const version = new DataView(new ArrayBuffer(4))
  version.setUint32(0, 7400, true)
  const chunks = [header, new Uint8Array(version.buffer)]
  let offset = header.length + 4
  for (const n of nodes) {
    const bytes = await encodeNode(n, offset)
    chunks.push(bytes)
    offset += bytes.length
  }
  chunks.push(NULL_RECORD)
  offset += 13
  // Standard footer: id, padding to 16 bytes, version, zeros, magic.
  const footerId = [0xfa, 0xbc, 0xab, 0x09, 0xd0, 0xc8, 0xd4, 0x66, 0xb1, 0x76, 0xfb, 0x83, 0x1c, 0xf7, 0x26, 0x7e]
  const pad = (16 - ((offset + 16) % 16)) % 16 || 16
  const tail = new Uint8Array(16 + 4 + pad + 4 + 120 + 16)
  tail.set(footerId, 0)
  new DataView(tail.buffer).setUint32(16 + 4 + pad, 7400, true)
  tail.set([0xf8, 0x5a, 0x8c, 0x6a, 0xde, 0xf5, 0xd9, 0x7e, 0xec, 0xe9, 0x0c, 0xe3, 0x75, 0x8f, 0x29, 0x0b], tail.length - 16)
  chunks.push(tail)
  return concat(chunks)
}

/**
 * meshes: [{ name, positions: Float32Array, normals, uvs, index: Uint32Array|null,
 *            material: { name, color: [r,g,b] (linear), opacity, specular, shininess, reflection, texture } }]
 * texture: { name, png: Uint8Array }
 */
export async function writeFBX(meshes, { title = 'Bottle' } = {}) {
  let nextId = 1000000
  const id = () => nextId++
  const objects = []
  const connections = []
  let textureCount = 0

  for (const mesh of meshes) {
    const modelId = id()
    const geomId = id()
    const matId = id()
    const count = mesh.positions.length / 3
    const index = mesh.index ?? Uint32Array.from({ length: count }, (_, i) => i)
    const polygon = new Int32Array(index.length)
    for (let i = 0; i < index.length; i += 3) {
      polygon[i] = index[i]
      polygon[i + 1] = index[i + 1]
      polygon[i + 2] = -index[i + 2] - 1 // negative marks the last vertex of each polygon
    }

    const layers = [node('LayerElement', [], [node('Type', [S('LayerElementNormal')]), node('TypedIndex', [I(0)])])]
    const geometryChildren = [
      node('Vertices', [ARR_D(mesh.positions)]),
      node('PolygonVertexIndex', [ARR_I(polygon)]),
      node('GeometryVersion', [I(124)]),
      node('LayerElementNormal', [I(0)], [
        node('Version', [I(101)]),
        node('Name', [S('')]),
        node('MappingInformationType', [S('ByVertice')]),
        node('ReferenceInformationType', [S('Direct')]),
        node('Normals', [ARR_D(mesh.normals)]),
      ]),
    ]
    if (mesh.uvs) {
      geometryChildren.push(
        node('LayerElementUV', [I(0)], [
          node('Version', [I(101)]),
          node('Name', [S('UVMap')]),
          node('MappingInformationType', [S('ByVertice')]),
          node('ReferenceInformationType', [S('Direct')]),
          node('UV', [ARR_D(mesh.uvs)]),
        ]),
      )
      layers.push(node('LayerElement', [], [node('Type', [S('LayerElementUV')]), node('TypedIndex', [I(0)])]))
    }
    geometryChildren.push(
      node('LayerElementMaterial', [I(0)], [
        node('Version', [I(101)]),
        node('Name', [S('')]),
        node('MappingInformationType', [S('AllSame')]),
        node('ReferenceInformationType', [S('IndexToDirect')]),
        node('Materials', [ARR_I([0])]),
      ]),
      node('Layer', [I(0)], [
        node('Version', [I(100)]),
        ...layers,
        node('LayerElement', [], [node('Type', [S('LayerElementMaterial')]), node('TypedIndex', [I(0)])]),
      ]),
    )
    objects.push(node('Geometry', [L(geomId), S(`${mesh.name}\x00\x01Geometry`), S('Mesh')], geometryChildren))

    objects.push(
      node('Model', [L(modelId), S(`${mesh.name}\x00\x01Model`), S('Mesh')], [
        node('Version', [I(232)]),
        node('Properties70', [], [P('DefaultAttributeIndex', 'int', 'Integer', '', I(0))]),
        node('Shading', [C(true)]),
        node('Culling', [S('CullingOff')]),
      ]),
    )

    const m = mesh.material
    const transparency = 1 - m.opacity
    objects.push(
      node('Material', [L(matId), S(`${m.name}\x00\x01Material`), S('')], [
        node('Version', [I(102)]),
        node('ShadingModel', [S('phong')]),
        node('MultiLayer', [I(0)]),
        node('Properties70', [], [
          P('DiffuseColor', 'Color', '', 'A', D(m.color[0]), D(m.color[1]), D(m.color[2])),
          P('DiffuseFactor', 'Number', '', 'A', D(1)),
          P('SpecularColor', 'Color', '', 'A', D(1), D(1), D(1)),
          P('SpecularFactor', 'Number', '', 'A', D(m.specular)),
          P('ShininessExponent', 'Number', '', 'A', D(m.shininess)),
          P('ReflectionFactor', 'Number', '', 'A', D(m.reflection)),
          P('TransparencyFactor', 'Number', '', 'A', D(transparency)),
          P('TransparentColor', 'Color', '', 'A', D(1), D(1), D(1)),
          P('Opacity', 'Number', '', 'A', D(m.opacity)),
        ]),
      ]),
    )

    connections.push(node('C', [S('OO'), L(modelId), L(0)]))
    connections.push(node('C', [S('OO'), L(geomId), L(modelId)]))
    connections.push(node('C', [S('OO'), L(matId), L(modelId)]))

    if (m.texture) {
      textureCount++
      const texId = id()
      const videoId = id()
      const file = `${m.texture.name}.png`
      objects.push(
        node('Video', [L(videoId), S(`${m.texture.name}\x00\x01Video`), S('Clip')], [
          node('Type', [S('Clip')]),
          node('Properties70', [], [P('Path', 'KString', 'XRefUrl', '', S(file))]),
          node('UseMipMap', [I(0)]),
          node('Filename', [S(file)]),
          node('RelativeFilename', [S(file)]),
          node('Content', [R(m.texture.png)]),
        ]),
      )
      objects.push(
        node('Texture', [L(texId), S(`${m.texture.name}\x00\x01Texture`), S('')], [
          node('Type', [S('TextureVideoClip')]),
          node('Version', [I(202)]),
          node('TextureName', [S(`${m.texture.name}\x00\x01Texture`)]),
          node('Properties70', [], [P('UVSet', 'KString', '', '', S('UVMap')), P('UseMaterial', 'bool', '', '', I(1))]),
          node('Media', [S(`${m.texture.name}\x00\x01Video`)]),
          node('FileName', [S(file)]),
          node('RelativeFilename', [S(file)]),
        ]),
      )
      connections.push(node('C', [S('OO'), L(videoId), L(texId)]))
      // Transparency comes from the texture's own alpha channel (prints, glass coating).
      connections.push(node('C', [S('OP'), L(texId), L(matId), S('DiffuseColor')]))
    }
  }

  const n = meshes.length
  const definitions = node('Definitions', [], [
    node('Version', [I(100)]),
    node('Count', [I(1 + n * 3 + textureCount * 2)]),
    node('ObjectType', [S('GlobalSettings')], [node('Count', [I(1)])]),
    node('ObjectType', [S('Model')], [node('Count', [I(n)])]),
    node('ObjectType', [S('Geometry')], [node('Count', [I(n)])]),
    node('ObjectType', [S('Material')], [node('Count', [I(n)])]),
    ...(textureCount
      ? [node('ObjectType', [S('Texture')], [node('Count', [I(textureCount)])]), node('ObjectType', [S('Video')], [node('Count', [I(textureCount)])])]
      : []),
  ])

  return encodeFile([
    node('FBXHeaderExtension', [], [
      node('FBXHeaderVersion', [I(1003)]),
      node('FBXVersion', [I(7400)]),
      node('Creator', [S('Neandertal Bottle Studio')]),
      node('SceneInfo', [S('GlobalInfo\x00\x01SceneInfo'), S('UserData')], [
        node('Type', [S('UserData')]),
        node('Version', [I(100)]),
        node('MetaData', [], [node('Version', [I(100)]), node('Title', [S(title)])]),
      ]),
    ]),
    node('GlobalSettings', [], [
      node('Version', [I(1000)]),
      node('Properties70', [], [
        P('UpAxis', 'int', 'Integer', '', I(1)),
        P('UpAxisSign', 'int', 'Integer', '', I(1)),
        P('FrontAxis', 'int', 'Integer', '', I(2)),
        P('FrontAxisSign', 'int', 'Integer', '', I(1)),
        P('CoordAxis', 'int', 'Integer', '', I(0)),
        P('CoordAxisSign', 'int', 'Integer', '', I(1)),
        P('OriginalUpAxis', 'int', 'Integer', '', I(1)),
        P('OriginalUpAxisSign', 'int', 'Integer', '', I(1)),
        P('UnitScaleFactor', 'double', 'Number', '', D(0.1)), // 1 unit = 1 mm (FBX counts in cm)
        P('OriginalUnitScaleFactor', 'double', 'Number', '', D(0.1)),
      ]),
    ]),
    node('Documents', [], [node('Count', [I(0)])]),
    node('References', []),
    definitions,
    node('Objects', [], objects),
    node('Connections', [], connections),
  ])
}
