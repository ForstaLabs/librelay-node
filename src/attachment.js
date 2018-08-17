// vim: ts=4:sw=4:expandtab

const fs = require('fs');
const path = require('path');


/** @class */
class Attachment {

    constructor({
        buffer=null,
        name='Attachment',
        type='application/octet-stream',
        mtime=new Date()
    }) {
        this.buffer = buffer;
        this.name = name;
        this.type = type;
        this.mtime = mtime;
    }

    /**
     * Produce an {Attachment} instance based on a local file-system file.
     *
     * @param {string} filePath
     * @param {string} [type] - The file mime type.
     */
    static fromFile(filePath, type) {
        const fStat = fs.statSync(filePath);
        const buffer = fs.readFileSync(filePath);
        return new this({
            buffer,
            mtime: fStat.mtime,
            name: path.basename(filePath),
            type
        });
    }

    getMeta() {
        return {
            name: this.name,
            size: this.buffer.size,
            type: this.type,
            mtime: this.mtime.toISOString(),
        };
    }
}

module.exports = Attachment;
