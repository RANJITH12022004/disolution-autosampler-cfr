/**
 * master_pf.h — Master sampler-chain power-fail checkpoint (NVS "mst_pf").
 *
 * Used by master_URAT.ino mstPfSave / mstPfLoad / mstPfResume to restore
 * mid-chain SMP → Air B → RPH → Air C after a brown-out while the bath
 * probe may still be DOWN.
 */
#ifndef MASTER_PF_H
#define MASTER_PF_H

#include <stdint.h>

#define MST_PF_MAGIC  0x4D505046u  /* 'MPF\0' */

typedef struct __attribute__((packed)) {
    uint32_t magic;
    uint8_t  version;
    uint8_t  active;
    uint8_t  autoChain;
    uint8_t  waitingCmt;
    char     pendingOp[16];
    float    sv;
    float    fh;
    float    flt;
    int16_t  st;
    float    airExtv;
    float    rphFlt;
    char     airSrc;
    uint8_t  pendSmpPhase;
    uint8_t  pendRphPhase;
    uint8_t  pendAirActive;
    uint8_t  pendSmpActive;
    uint8_t  pendRphActive;
    uint8_t  _pad[2];
} MasterCheckpoint;

#endif /* MASTER_PF_H */
