/*
 * Copyright (c) Shelly-HomeKit Contributors
 * All rights reserved
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

#include "shelly_pm_bl0937.hpp"

#include <cmath>

#include "mgos.hpp"
#include "mgos_iram.h"

namespace shelly {

BL0937PowerMeter::BL0937PowerMeter(int id, int cf_pin, int cf1_pin, int sel_pin,
                                   int meas_time, float apc, float cpc,
                                   float vpc)
    : PowerMeter(id),
      cf_pin_(cf_pin),
      cf1_pin_(cf1_pin),
      sel_pin_(sel_pin),
      meas_time_(meas_time),
      apc_(apc),
      cpc_(cpc),
      vpc_(vpc),
      meas_timer_(std::bind(&BL0937PowerMeter::MeasureTimerCB, this)) {
}

BL0937PowerMeter::~BL0937PowerMeter() {
  if (cf_pin_ >= 0) {
    mgos_gpio_disable_int(cf_pin_);
    mgos_gpio_remove_int_handler(cf_pin_, nullptr, nullptr);
  }
}

Status BL0937PowerMeter::Init() {
  if (cf_pin_ < 0 && cf1_pin_ < 0) {
    return mgos::Errorf(STATUS_INVALID_ARGUMENT, "no valid pins");
  }
  if (cf_pin_ >= 0) {
    if (apc_ <= 0) {
      return mgos::Errorf(STATUS_INVALID_ARGUMENT, "power_coeff not set");
    }
    mgos_gpio_setup_input(cf_pin_, MGOS_GPIO_PULL_NONE);
    mgos_gpio_set_int_handler_isr(cf_pin_, MGOS_GPIO_INT_EDGE_POS,
                                  &BL0937PowerMeter::GPIOIntHandler,
                                  (void *) &cf_count_);
    mgos_gpio_enable_int(cf_pin_);
  }
  if (cf1_pin_ >= 0) {
    mgos_gpio_setup_input(cf1_pin_, MGOS_GPIO_PULL_NONE);
    mgos_gpio_set_int_handler_isr(cf1_pin_, MGOS_GPIO_INT_EDGE_POS,
                                  &BL0937PowerMeter::GPIOIntHandler,
                                  (void *) &cf1_count_);
    mgos_gpio_enable_int(cf1_pin_);
  }
  if (sel_pin_ >= 0) {
    mgos_gpio_setup_output(sel_pin_, 0);  // Select current measurement mode.
  }
  meas_start_ = mgos_uptime_micros();
  meas_timer_.Reset(meas_time_ * 1000, MGOS_TIMER_REPEAT);
  LOG(LL_INFO, ("BL0937 @ %d/%d/%d apc %f", cf_pin_, cf1_pin_, sel_pin_, apc_));
  return Status::OK();
}

StatusOr<float> BL0937PowerMeter::GetPowerW() {
  return apa_;
}

StatusOr<float> BL0937PowerMeter::GetEnergyWH() {
  return aea_;
}

StatusOr<float> BL0937PowerMeter::GetCurrentA() {
  // CF1 pulses track RMS current while SEL selects the current channel;
  // usable once the pulses/sec -> amps coefficient has been calibrated.
  if (cf1_pin_ < 0 || cpc_ <= 0) {
    return mgos::Errorf(STATUS_UNIMPLEMENTED, "current not calibrated");
  }
  return ca_;
}

StatusOr<float> BL0937PowerMeter::GetVoltageV() {
  // Requires a SEL pin to switch CF1 to the voltage channel and a calibrated
  // pulses/sec -> volts coefficient.
  if (!VoltageSensingEnabled()) {
    return mgos::Errorf(STATUS_UNIMPLEMENTED, "voltage not calibrated");
  }
  return vo_;
}

// static
IRAM void BL0937PowerMeter::GPIOIntHandler(int pin, void *arg) {
  (*((uint32_t *) arg))++;
  (void) pin;
}

void BL0937PowerMeter::MeasureTimerCB() {
  uint32_t cf_count = cf_count_, cf1_count = cf1_count_;
  float elapsed_sec = (mgos_uptime_micros() - meas_start_) / 1000000.0f;
  if (cf_count < 2) cf_count = 0;    // Noise
  if (cf1_count < 2) cf1_count = 0;  // Noise
  float cfps = (cf_count / elapsed_sec), cf1ps = (cf1_count / elapsed_sec);
  // CF (power) is independent of SEL and measured every cycle.
  apa_ = cfps * apc_;                       // Watts
  aea_ += (apa_ / (3600.0f / meas_time_));  // Watt-hours

  // CF1 (current or voltage). Ignore the reading during a settle cycle (the
  // first cycle after a SEL switch), while the CF1 output stabilizes.
  if (!cf1_settling_) {
    if (cf1_on_voltage_) {
      if (vpc_ > 0) vo_ = cf1ps * vpc_;  // Volts
    } else {
      if (cpc_ > 0) ca_ = cf1ps * cpc_;  // Amps
    }
  }
  // If both channels are calibrated, alternate SEL: consume one valid reading,
  // then switch and spend the next cycle settling. Each channel thus refreshes
  // every 4 cycles; power keeps refreshing every cycle. When voltage sensing is
  // off, SEL stays on the current channel and this whole block is skipped.
  if (VoltageSensingEnabled() && cpc_ > 0) {
    if (cf1_settling_) {
      cf1_settling_ = false;  // Settle cycle done; next cycle reads.
    } else {
      cf1_on_voltage_ = !cf1_on_voltage_;
      mgos_gpio_write(sel_pin_, cf1_on_voltage_ ? 1 : 0);
      cf1_settling_ = true;
    }
  }
  LOG(LL_DEBUG,
      ("cfcnt %d cfps %.2f, cf1cnt %d cf1ps %.2f (%s%s); apa %.2f aea %.2f "
       "ca %.3f vo %.1f",
       (int) cf_count, cfps, (int) cf1_count, cf1ps,
       (cf1_on_voltage_ ? "V" : "I"), (cf1_settling_ ? " settle" : ""), apa_,
       aea_, ca_, vo_));
  // Start new measurement cycle.
  mgos_ints_disable();
  cf_count_ = 0;
  cf1_count_ = 0;
  meas_start_ = mgos_uptime_micros();
  mgos_ints_enable();
}

}  // namespace shelly
