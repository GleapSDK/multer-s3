var crypto = require("crypto");
var stream = require("stream");
var fileType = require("file-type");
var htmlCommentRegex = require("html-comment-regex");
var parallel = require("run-parallel");
var Upload = require("@aws-sdk/lib-storage").Upload;
var DeleteObjectCommand = require("@aws-sdk/client-s3").DeleteObjectCommand;
var util = require("util");
const sanitizeHtml = require("sanitize-html"); // Add this to your imports

// Sanitize SVG function
const sanitizeSvg = (svgContent) => {
  return sanitizeHtml(svgContent, {
    allowedTags: [
      "svg",
      "g",
      "path",
      "rect",
      "circle",
      "text",
      "line",
      "polygon",
      "polyline",
      "ellipse",
    ],
    allowedAttributes: {
      "*": [
        "style",
        "fill",
        "stroke",
        "d",
        "points",
        "x",
        "y",
        "cx",
        "cy",
        "r",
        "width",
        "height",
        "viewBox",
        "xlink:href",
      ],
    },
    allowedSchemes: ["http", "https"],
  });
};

function staticValue(value) {
  return function (req, file, cb) {
    cb(null, value);
  };
}

var defaultAcl = staticValue("private");
var defaultContentType = staticValue("application/octet-stream");

var defaultMetadata = staticValue(undefined);
var defaultCacheControl = staticValue(null);
var defaultContentDisposition = staticValue(null);
var defaultContentEncoding = staticValue(null);
var defaultStorageClass = staticValue("STANDARD");
var defaultSSE = staticValue(null);
var defaultSSEKMS = staticValue(null);

// Regular expression to detect svg file content, inspired by: https://github.com/sindresorhus/is-svg/blob/master/index.js
// It is not always possible to check for an end tag if a file is very big. The firstChunk, see below, might not be the entire file.
var svgRegex = /^\s*(?:<\?xml[^>]*>\s*)?(?:<!doctype svg[^>]*>\s*)?<svg[^>]*>/i;

function isSvg(svg) {
  // Remove DTD entities
  svg = svg.replace(/\s*<!Entity\s+\S*\s*(?:"|')[^"]+(?:"|')\s*>/gim, "");
  // Remove DTD markup declarations
  svg = svg.replace(/\[?(?:\s*<![A-Z]+[^>]*>\s*)*\]?/g, "");
  // Remove HTML comments
  svg = svg.replace(htmlCommentRegex, "");

  // Sanitize the SVG content
  const sanitizedSvg = sanitizeSvg(svg);

  return svgRegex.test(sanitizedSvg);
}

function defaultKey(req, file, cb) {
  crypto.randomBytes(16, function (err, raw) {
    cb(err, err ? undefined : raw.toString("hex"));
  });
}

// Modify the autoContentType function
function autoContentType(req, file, cb) {
  let firstChunkReceived = false;

  file.stream.once("data", function (firstChunk) {
    firstChunkReceived = true;

    const type = fileType(firstChunk);
    let mime = "application/octet-stream"; // default type

    const chunkString = firstChunk.toString();

    // Check if the content is SVG
    if (
      (!type || type.ext === "xml" || type.mime === "image/svg+xml") &&
      isSvg(chunkString)
    ) {
      // It's an SVG, buffer and sanitize the entire file
      const chunks = [firstChunk];
      let fileSize = firstChunk.length;
      const MAX_SVG_SIZE = 1 * 1024 * 1024; // 1 MB limit for SVG files

      file.stream.on("data", function (chunk) {
        fileSize += chunk.length;
        if (fileSize > MAX_SVG_SIZE) {
          return cb(
            new Error("SVG file size exceeds the maximum allowed limit.")
          );
        }
        chunks.push(chunk);
      });

      file.stream.on("end", function () {
        const fileBuffer = Buffer.concat(chunks);
        const fileContent = fileBuffer.toString();

        // Sanitize the entire SVG content
        const sanitizedSvg = sanitizeSvg(fileContent);
        mime = "image/svg+xml";

        // Create a new stream from the sanitized content
        const outStream = new stream.PassThrough();
        outStream.end(Buffer.from(sanitizedSvg));

        cb(null, mime, outStream);
      });

      file.stream.on("error", function (err) {
        cb(err);
      });
    } else {
      // For non-SVG files, proceed normally using streaming
      if (type) {
        mime = type.mime;
      }

      const outStream = new stream.PassThrough();
      outStream.write(firstChunk);
      file.stream.pipe(outStream);

      cb(null, mime, outStream);
    }
  });

  file.stream.on("error", function (err) {
    if (!firstChunkReceived) {
      cb(err);
    }
  });
}

function collect(storage, req, file, cb) {
  parallel(
    [
      storage.getBucket.bind(storage, req, file),
      storage.getKey.bind(storage, req, file),
      storage.getAcl.bind(storage, req, file),
      storage.getMetadata.bind(storage, req, file),
      storage.getCacheControl.bind(storage, req, file),
      storage.getContentDisposition.bind(storage, req, file),
      storage.getStorageClass.bind(storage, req, file),
      storage.getSSE.bind(storage, req, file),
      storage.getSSEKMS.bind(storage, req, file),
      storage.getContentEncoding.bind(storage, req, file),
    ],
    function (err, values) {
      if (err) return cb(err);

      storage.getContentType(
        req,
        file,
        function (err, contentType, replacementStream) {
          if (err) return cb(err);

          cb.call(storage, null, {
            bucket: values[0],
            key: values[1],
            acl: values[2],
            metadata: values[3],
            cacheControl: values[4],
            contentDisposition: values[5],
            storageClass: values[6],
            contentType: contentType,
            replacementStream: replacementStream,
            serverSideEncryption: values[7],
            sseKmsKeyId: values[8],
            contentEncoding: values[9],
          });
        }
      );
    }
  );
}

function S3Storage(opts) {
  switch (typeof opts.s3) {
    case "object":
      this.s3 = opts.s3;
      break;
    default:
      throw new TypeError("Expected opts.s3 to be object");
  }

  switch (typeof opts.bucket) {
    case "function":
      this.getBucket = opts.bucket;
      break;
    case "string":
      this.getBucket = staticValue(opts.bucket);
      break;
    case "undefined":
      throw new Error("bucket is required");
    default:
      throw new TypeError(
        "Expected opts.bucket to be undefined, string or function"
      );
  }

  switch (typeof opts.key) {
    case "function":
      this.getKey = opts.key;
      break;
    case "undefined":
      this.getKey = defaultKey;
      break;
    default:
      throw new TypeError("Expected opts.key to be undefined or function");
  }

  switch (typeof opts.acl) {
    case "function":
      this.getAcl = opts.acl;
      break;
    case "string":
      this.getAcl = staticValue(opts.acl);
      break;
    case "undefined":
      this.getAcl = defaultAcl;
      break;
    default:
      throw new TypeError(
        "Expected opts.acl to be undefined, string or function"
      );
  }

  switch (typeof opts.contentType) {
    case "function":
      this.getContentType = opts.contentType;
      break;
    case "undefined":
      this.getContentType = defaultContentType;
      break;
    default:
      throw new TypeError(
        "Expected opts.contentType to be undefined or function"
      );
  }

  switch (typeof opts.metadata) {
    case "function":
      this.getMetadata = opts.metadata;
      break;
    case "undefined":
      this.getMetadata = defaultMetadata;
      break;
    default:
      throw new TypeError("Expected opts.metadata to be undefined or function");
  }

  switch (typeof opts.cacheControl) {
    case "function":
      this.getCacheControl = opts.cacheControl;
      break;
    case "string":
      this.getCacheControl = staticValue(opts.cacheControl);
      break;
    case "undefined":
      this.getCacheControl = defaultCacheControl;
      break;
    default:
      throw new TypeError(
        "Expected opts.cacheControl to be undefined, string or function"
      );
  }

  switch (typeof opts.contentDisposition) {
    case "function":
      this.getContentDisposition = opts.contentDisposition;
      break;
    case "string":
      this.getContentDisposition = staticValue(opts.contentDisposition);
      break;
    case "undefined":
      this.getContentDisposition = defaultContentDisposition;
      break;
    default:
      throw new TypeError(
        "Expected opts.contentDisposition to be undefined, string or function"
      );
  }

  switch (typeof opts.contentEncoding) {
    case "function":
      this.getContentEncoding = opts.contentEncoding;
      break;
    case "string":
      this.getContentEncoding = staticValue(opts.contentEncoding);
      break;
    case "undefined":
      this.getContentEncoding = defaultContentEncoding;
      break;
    default:
      throw new TypeError(
        "Expected opts.contentEncoding to be undefined, string or function"
      );
  }

  switch (typeof opts.storageClass) {
    case "function":
      this.getStorageClass = opts.storageClass;
      break;
    case "string":
      this.getStorageClass = staticValue(opts.storageClass);
      break;
    case "undefined":
      this.getStorageClass = defaultStorageClass;
      break;
    default:
      throw new TypeError(
        "Expected opts.storageClass to be undefined, string or function"
      );
  }

  switch (typeof opts.serverSideEncryption) {
    case "function":
      this.getSSE = opts.serverSideEncryption;
      break;
    case "string":
      this.getSSE = staticValue(opts.serverSideEncryption);
      break;
    case "undefined":
      this.getSSE = defaultSSE;
      break;
    default:
      throw new TypeError(
        "Expected opts.serverSideEncryption to be undefined, string or function"
      );
  }

  switch (typeof opts.sseKmsKeyId) {
    case "function":
      this.getSSEKMS = opts.sseKmsKeyId;
      break;
    case "string":
      this.getSSEKMS = staticValue(opts.sseKmsKeyId);
      break;
    case "undefined":
      this.getSSEKMS = defaultSSEKMS;
      break;
    default:
      throw new TypeError(
        "Expected opts.sseKmsKeyId to be undefined, string, or function"
      );
  }
}

S3Storage.prototype._handleFile = function (req, file, cb) {
  collect(this, req, file, function (err, opts) {
    if (err) return cb(err);

    var currentSize = 0;

    var params = {
      Bucket: opts.bucket,
      Key: opts.key,
      ACL: opts.acl,
      CacheControl: opts.cacheControl,
      ContentType: opts.contentType,
      Metadata: opts.metadata,
      StorageClass: opts.storageClass,
      ServerSideEncryption: opts.serverSideEncryption,
      SSEKMSKeyId: opts.sseKmsKeyId,
      Body: opts.replacementStream || file.stream,
    };

    if (opts.contentDisposition) {
      params.ContentDisposition = opts.contentDisposition;
    }

    if (opts.contentEncoding) {
      params.ContentEncoding = opts.contentEncoding;
    }

    var upload = new Upload({
      client: this.s3,
      params: params,
    });

    upload.on("httpUploadProgress", function (ev) {
      if (ev.total) currentSize = ev.total;
    });

    util.callbackify(upload.done.bind(upload))(function (err, result) {
      if (err) return cb(err);

      cb(null, {
        size: currentSize,
        bucket: opts.bucket,
        key: opts.key,
        acl: opts.acl,
        contentType: opts.contentType,
        contentDisposition: opts.contentDisposition,
        contentEncoding: opts.contentEncoding,
        storageClass: opts.storageClass,
        serverSideEncryption: opts.serverSideEncryption,
        metadata: opts.metadata,
        location: result.Location,
        etag: result.ETag,
        versionId: result.VersionId,
      });
    });
  });
};

S3Storage.prototype._removeFile = function (req, file, cb) {
  this.s3.send(
    new DeleteObjectCommand({
      Bucket: file.bucket,
      Key: file.key,
    }),
    cb
  );
};

module.exports = function (opts) {
  return new S3Storage(opts);
};

module.exports.AUTO_CONTENT_TYPE = autoContentType;
module.exports.DEFAULT_CONTENT_TYPE = defaultContentType;
