import mongoose, { Schema } from 'mongoose';

import { MONGO_DATABASE, MONGO_USER, MONGO_PASSWORD } from './config.js';

const MONGO_ADDR = process.env.MONGO_PORT_27017_TCP_ADDR || 'localhost';
const MONGO_PORT = process.env.MONGO_PORT_27017_TCP_PORT || 27017;

mongoose.Promise = Promise;

mongoose.connect(
  `mongodb://${MONGO_ADDR}:${MONGO_PORT}/${MONGO_DATABASE}`,
  {
    user: MONGO_USER,
    pass: MONGO_PASSWORD
  }
);

const imageSchema = new Schema(
  {
    id: { type: Number, index: true },
    src: String,
    original_source: String,
    format: String,
    mime_type: String,
    status: { type: String, index: true },
  },
  {
    timestamps: true
  }
);

const Image = mongoose.model('Image', imageSchema);

export default {
  mongoose,
  Image
};
