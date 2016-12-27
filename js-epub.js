(function (GLOBAL) {
    var JSEpub = function (blob) {
        this.blob = blob;
    };

    GLOBAL.JSEpub = JSEpub;

    JSEpub.prototype = {

        getCompressedFile: function (href) {
            /** Get zip entry of opf file */
            var target;
            for(var i= 0, l=this.compressedFiles.length; i<l; i++) {
                if (this.compressedFiles[i].filename === href) {
                    target = this.compressedFiles[i];
                    break;
                }
            }
            if (! target) {
                throw new Error('no compressed file found (' + href + ') in package');
            }
            return target;
        },
        // None-blocking processing of the EPUB. The notifier callback will
        // get called with a number and a optional info parameter on various
        // steps of the processing:
        //
        //  1: Unzipp(ing|ed). Number of total files passed as 2nd argument
        //  2: Uncompressing file. File name passed as 2nd argument.
        //  3: Reading OPF
        //  4: Post processing
        //  5: Finished!
        //
        // Error codes:
        //  -1: File is not a proper Zip file.
        processInSteps: function (notifier) {
            notifier(1);
            var self = this;

            this.unzipBlob(notifier)
                .then(function () {
                    notifier(1, self.compressedFiles.length);
                    self.files = {};

                    /** Read container.xml to retrieve opf */
                    self.uncompressFile(self.getCompressedFile('META-INF/container.xml'))
                        .then(function () {
                            self.opfPath = self.getOpfPathFromContainer();

                            /** Read opf to retrieve media files metadata */
                            self.uncompressFile(self.getCompressedFile(self.opfPath))
                                .then(function () {
                                    self.readOpf(self.files[self.opfPath]);

                                    /** Uncompress the rest files */
                                    self.uncompressAllFiles(notifier)
                                        .then(self.didUncompressAllFiles.bind(self, notifier))
                                        .catch(function () {
                                            notifier(-1);
                                            console.error('uncompress error', arguments);
                                        });
                                });
                        });
                })
                .catch(notifier.bind(null, -1));
        },

        unzipBlob: function () {
            var self = this;

            return new Promise(function (resolve, reject) {
                zip.createReader(new zip.BlobReader(self.blob), function(zipReader) {
                    zipReader.getEntries(function (entries) {
                        self.compressedFiles = entries;
                        resolve();
                    });
                }, reject);
            });
        },

        uncompressAllFiles: function (notifier) {
            var self = this;

            return this.compressedFiles.reduce(
                function (previous, item) {
                    return previous.then(function (previousValue) {
                        notifier(2, previousValue);
                        return self.uncompressFile(item);
                    })
                },
                new Promise(function (resolve) { resolve(); })
            );
        },

        didUncompressAllFiles: function (notifier) {
            notifier(3);
            notifier(4);
            this.postProcess();
            notifier(5);
        },

        uncompressFile: function (compressedFile) {
            var self = this;
            var mime = self.opf && this.findMediaTypeByHref(compressedFile.filename);

            /** Binary files should be read as dara URI */
            var writer = (! mime || mime.match(/(plain|xml|html|css)\w*$/i))
                ? new zip.TextWriter()
                : new zip.Data64URIWriter(mime);

            return new Promise(function (resolve, reject) {
                compressedFile.getData(writer, function(data) {
                    if (compressedFile.filename === "META-INF/container.xml") {
                        self.container = data;
                    } else if (compressedFile.filename === "mimetype") {
                        self.mimetype = data;
                    } else {
                        self.files[compressedFile.filename] = data;
                    }
                    resolve(compressedFile.filename);

                }, function (e) {
                    // console.log('uncompress %s progress %o', compressedFile.filename, e);
                });
            });
        },

        getOpfPathFromContainer: function () {
            var doc = this.xmlDocument(this.container);
            return doc
                .getElementsByTagName("rootfile")[0]
                .getAttribute("full-path");
        },

        readOpf: function (xml) {
            var doc = this.xmlDocument(xml);

            var opf = {
                metadata: {},
                manifest: {},
                spine: []
            };

            var metadataNodes = doc
                .getElementsByTagName("metadata")[0]
                .childNodes;

            for (var i = 0, il = metadataNodes.length; i < il; i++) {
                var node = metadataNodes[i];
                // Skip text nodes (whitespace)
                if (node.nodeType === 3) { continue }

                var attrs = {};
                for (var i2 = 0, il2 = node.attributes.length; i2 < il2; i2++) {
                    var attr = node.attributes[i2];
                    attrs[attr.name] = attr.value;
                }
                attrs._text = node.textContent;
                opf.metadata[node.nodeName] = attrs;
            }

            var manifestEntries = doc
                .getElementsByTagName("manifest")[0]
                .getElementsByTagName("item");

            for (var i = 0, il = manifestEntries.length; i < il; i++) {
                var node = manifestEntries[i];

                opf.manifest[node.getAttribute("id")] = {
                    "href": this.resolvePath(node.getAttribute("href"), this.opfPath),
                    "media-type": node.getAttribute("media-type")
                }
            }

            var spineEntries = doc
                .getElementsByTagName("spine")[0]
                .getElementsByTagName("itemref");

            for (var i = 0, il = spineEntries.length; i < il; i++) {
                var node = spineEntries[i];
                opf.spine.push(node.getAttribute("idref"));
            }

            this.opf = opf;
        },

        resolvePath: function (path, referrerLocation) {
            var pathDirs = path.split("/");
            var fileName = pathDirs.pop();

            var locationDirs = referrerLocation.split("/");
            locationDirs.pop();

            for (var i = 0, il = pathDirs.length; i < il; i++) {
                var spec = pathDirs[i];
                if (spec === "..") {
                    locationDirs.pop();
                } else {
                    locationDirs.push(spec);
                }
            }

            locationDirs.push(fileName);
            return locationDirs.join("/");
        },

        findMediaTypeByHref: function (href) {
            for (key in this.opf.manifest) {
                var item = this.opf.manifest[key];
                if (item["href"] === href) {
                    return item["media-type"];
                }
            }

            // Best guess if it's not in the manifest. (Those bastards.)
            var match = href.match(/\.(\w+)$/);
            return match && "image/" + match[1];
        },

        // Will modify all HTML and CSS files in place.
        postProcess: function () {
            for (var key in this.opf.manifest) {
                var mediaType = this.opf.manifest[key]["media-type"];
                var href = this.opf.manifest[key]["href"];
                var result = undefined;

                if (mediaType === "text/css") {
                    result = this.postProcessCSS(href);
                } else if (mediaType === "application/xhtml+xml") {
                    result = this.postProcessHTML(href);
                }

                if (result !== undefined) {
                    this.files[href] = result;
                }
            }
        },

        postProcessCSS: function (href) {
            var file = this.files[href];
            var self = this;

            file = file.replace(/url\((.*?)\)/gi, function (str, url) {
                if (/^data/i.test(url)) {
                    // Don't replace data strings
                    return str;
                } else {
                    var dataUri = self.getDataUri(url, href);
                    return "url(" + dataUri + ")";
                }
            });

            return file;
        },

        postProcessHTML: function (href) {
            var crawl = function (nodes, attr) {
                for (var i = 0, il = nodes.length; i < il; i++) {
                    try {
                        var image = nodes[i];
                        var src = image.getAttribute(attr);
                        if (/^data/.test(src)) { continue }
                        image.setAttribute(attr, this.getDataUri(src, href));
                    }
                    catch (e) {
                        console.log('failed to process image url', e);
                    }
                }
            }.bind(this);

            var doc = this.xmlDocument(this.files[href]);
            var head = doc.getElementsByTagName("head")[0];
            var links = head ? head.getElementsByTagName("link") : [];

            crawl(doc.getElementsByTagName("img"), 'src');
            crawl(doc.getElementsByTagName("image"), 'xlink:href');

            for (var i = 0, il = links.length; i < il; i++) {
                var link = links[0];
                if (link.getAttribute("type") === "text/css") {
                    var inlineStyle = document.createElement("style");
                    inlineStyle.setAttribute("type", "text/css");
                    inlineStyle.setAttribute("data-orig-href", link.getAttribute("href"));

                    var css = this.files[this.resolvePath(link.getAttribute("href"), href)];
                    inlineStyle.appendChild(document.createTextNode(css));

                    head.replaceChild(inlineStyle, link);
                }
            }

            return doc;
        },

        getDataUri: function (url, href) {
            var dataHref = this.resolvePath(url, href);
            return this.files[dataHref];
        },

        validate: function () {
            if (this.container === undefined) {
                throw new Error("META-INF/container.xml file not found.");
            }

            if (this.mimetype === undefined) {
                throw new Error("Mimetype file not found.");
            }

            if (this.mimetype !== "application/epub+zip") {
                throw new Error("Incorrect mimetype " + this.mimetype);
            }
        },

        // for data URIs
        escapeData: function (data) {
            return escape(data);
        },

        xmlDocument: function (xml) {
            var doc = new DOMParser().parseFromString(xml, "text/xml");

            if (doc.childNodes[1] && doc.childNodes[1].nodeName === "parsererror") {
                throw doc.childNodes[1].childNodes[0].nodeValue;
            }

            return doc;
        }
    }
}(this));