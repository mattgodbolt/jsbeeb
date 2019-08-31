NPM_UP_TO_DATE:=.npm-up-to-date
NODE=node

all: test

npm: $(NPM_UP_TO_DATE)

$(NPM_UP_TO_DATE): package.json
	npm install
	touch $(NPM_UP_TO_DATE)

test-suite: npm
	$(NODE) tests/test-suite.js

unit-tests: npm
	$(NODE) ./node_modules/.bin/mocha tests/unit

timing-tests: npm
	$(NODE) tests/test-node.js

dormann-test: npm
	$(NODE) tests/test-dormann.js

lint: npm
	$(NODE) ./node_modules/.bin/jshint --version
	$(NODE) ./node_modules/.bin/jshint $(shell find -name '*.js' -not -path './node_modules/*' -not -path './out/*' -not -path './lib/*' -not -path './tests/*' -not -path './.git/*')

short-tests: unit-tests timing-tests dormann-test
long-tests: test-suite 

HASH := $(shell git rev-parse HEAD)

dist: npm
	@rm -rf out/build out/dist
	@mkdir -p out/dist
	@mkdir -p out/build
	cp -r *.js *.css *.html *.txt *.ico discs tapes basic images lib roms sounds out/build
	for BASEFILE in main requirejs-common; do \
		perl -pi -e "s/require\(\['$${BASEFILE}'\]/require(['$${BASEFILE}-$(HASH)']/" out/build/index.html; \
		mv out/build/$${BASEFILE}.js out/build/$${BASEFILE}-$(HASH).js; \
	done
	m4 -DHASH=$(HASH) -DDEPLOY_DIR=$(shell pwd)/out/dist '-DCOMMON_SETTINGS=$(shell $(NODE) -e 'requirejs = {config: function(c) { c.baseUrl = "."; console.log(JSON.stringify(c)); }}; require("./requirejs-common.js");' | sed 's/^.\(.*\).$$/\1/')' build.js.template > out/build.js
	cd out/build && $(shell pwd)/node_modules/requirejs/bin/r.js -o ../build.js

upload: dist
	aws s3 sync out/dist/ s3://bbc.godbolt.org/$(BRANCH) --cache-control max-age=30 --metadata-directive REPLACE

clean:
	@rm -rf out

spotless: clean
	@rm -f $(NPM_UP_TO_DATE)

test: short-tests long-tests lint

.PHONY: test short-tests test dormann-test timing-tests unit-tests test-suite npm 
.PHONY: all dist clean spotless upload
