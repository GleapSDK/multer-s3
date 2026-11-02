/* eslint-env mocha */

var assert = require('assert')
var sanitizeSvg = require('../').sanitizeSvg

describe('sanitizeSvg', function () {
  it('keeps fill-rule and rounded corners', function () {
    var out = sanitizeSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" role="img" aria-label="Logo">' +
      '<g fill="#111" fill-rule="evenodd"><path d="M0 0H10V10H0ZM2 2H8V8H2Z"/></g>' +
      '<rect x="1" y="1" width="8" height="8" rx="2" ry="2" fill="#315BF9"/>' +
      '</svg>'
    )

    assert.ok(out.indexOf('fill-rule="evenodd"') !== -1, out)
    assert.ok(out.indexOf('rx="2"') !== -1, out)
    assert.ok(out.indexOf('ry="2"') !== -1, out)
    assert.ok(out.indexOf('aria-label="Logo"') !== -1, out)
  })

  it('keeps gradient stops', function () {
    var out = sanitizeSvg(
      '<svg><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1" gradientUnits="userSpaceOnUse">' +
      '<stop offset="0.5" stop-color="#fff" stop-opacity="0.4"/></linearGradient></defs>' +
      '<rect width="10" height="10" fill="url(#g)"/></svg>'
    )

    assert.ok(out.indexOf('x2="1"') !== -1, out)
    assert.ok(out.indexOf('gradientUnits="userSpaceOnUse"') !== -1, out)
    assert.ok(out.indexOf('offset="0.5"') !== -1, out)
    assert.ok(out.indexOf('stop-color="#fff"') !== -1, out)
  })

  it('still strips scripts and event handlers', function () {
    var out = sanitizeSvg(
      '<svg onload="alert(1)"><script>alert(2)</script>' +
      '<rect width="10" height="10" onclick="alert(3)" rx="2"/>' +
      '<foreignObject><iframe src="https://example.com"></iframe></foreignObject></svg>'
    )

    assert.strictEqual(out.indexOf('alert'), -1, out)
    assert.strictEqual(out.indexOf('onload'), -1, out)
    assert.strictEqual(out.indexOf('onclick'), -1, out)
    assert.strictEqual(out.indexOf('iframe'), -1, out)
    assert.strictEqual(out.indexOf('foreignObject'), -1, out)
    assert.ok(out.indexOf('rx="2"') !== -1, out)
  })
})
