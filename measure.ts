// socket-function's measure module statically imports its misc.ts, which fails
// to type-check under this project's lib settings (a Buffer/SharedArrayBuffer
// mismatch inside the dependency). Loading it through require keeps that source
// out of our type-check graph while still resolving normally at runtime, since
// we compile to CommonJS.
const measure = require("socket-function/src/profiling/measure");

export interface MeasureStat {
    count: number;
    sum: number;
}
export interface MeasureProfile {
    entries: { [name: string]: { ownTime: MeasureStat } };
}

export const measureFnc: (target: any, propertyKey: string, descriptor: PropertyDescriptor) => void = measure.measureFnc;
export const startMeasure: () => { finish: () => MeasureProfile } = measure.startMeasure;
export const createMeasureProfile: () => MeasureProfile = measure.createMeasureProfile;
export const addToMeasureProfile: (base: MeasureProfile, other: MeasureProfile) => void = measure.addToMeasureProfile;
