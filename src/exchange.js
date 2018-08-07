
const currentVersion = 1;
const ExchangeClasses = {};


exports.decode = function(data) {
    const ordered = Array.from(data).sort((a, b) => a.version < b.version ? 1 : -1);
    for (const x of ordered) {
        if (ExchangeClasses.hasOwnProperty(x.version)) {
            return new ExchangeClasses[x.version](x);
        }
    }
    throw new ReferenceError("No supported exchange versions found");
};


exports.encode = function(exchange) {
    return [exchange];
};


exports.create = function(attrs) {
    return new ExchangeClasses[currentVersion](attrs);
};


exports.Exchange = class Exchange {
    constructor(attrs) {
        Object.assign(this, attrs);
    }
};


exports.ExchangeV1 = class ExchangeV1 extends exports.Exchange {

    getBody(type) {
        if (this.data && this.data.body) {
            const entry = this.data.body.find(x => x.type === type);
            if (entry) {
                return entry.value;
            }
        }
    }

    getText() {
        return this.getBody('text/plain');
    }

    getHtml() {
        return this.getBody('text/html') || this.getText();
    }
};
ExchangeClasses[1] = exports.ExchangeV1;

